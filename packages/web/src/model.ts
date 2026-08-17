/**
 * Everything the panel shows, computed by `packages/sim`.
 *
 * ## Why this is a worker rather than a debounced call
 *
 * The full geometric metric set costs about a second at the bench's sampling
 * density and a quarter of that at the coarsest density that still means
 * anything. Run on the main thread, that is a second in which the sphere does
 * not turn — and the whole value of an interactive page is that the picture
 * follows the hand. So the shader keeps sixty frames a second on the main thread
 * and the truth arrives a beat later, which is the honest trade: the numbers are
 * never wrong, they are occasionally a moment behind, and the page says which.
 *
 * ## Two densities, and the page tells you which one you are reading
 *
 * A metric whose value depends on a sample count the reader cannot see is a
 * metric the reader cannot check. While a slider is moving the page asks for a
 * coarse pass; when it settles it asks for the full one. Both carry
 * `densityScale` in the reply and the page prints it.
 *
 * ## What this worker will not do
 *
 * It will not import `packages/solver`. That is not a boundary rule — a page may
 * legitimately use both sides, and `worker/solve.ts` does — it is a scoping one:
 * this worker answers "what does the model say about this rig", and the answer
 * must not be able to depend on what an inverse model thinks. Keeping the two
 * in separate workers makes that structural instead of a comment.
 */

import type { RigCalibration } from '../../calibration/src/index.ts';
import { angleBetweenDeg, projectorBasis, raySphereIntersect } from '../../sim/src/geometry.ts';
import { pixelToRay, prepareRig, worldToPixelUnbounded } from '../../sim/src/optics.ts';
import type { PreparedRig } from '../../sim/src/optics.ts';
import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import type { MetricSet } from '../../sim/src/metrics/index.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import { renderProjectorView } from '../../sim/src/render.ts';
import type { ViewerCamera } from '../../sim/src/render.ts';
import { buildWorld } from './rigs.ts';
import { framebufferSentence, projectorFacts, readingsFrom, rigFacts } from './readout.ts';
import type { EquirectImage } from '../../sim/src/equirect.ts';
import type { FrameImage, ModelRequest, ModelResponse, WarpMesh } from './protocol.ts';

/**
 * The last supplied image, held across requests.
 *
 * The page sends one only when it changes; every other request carries the id
 * alone. Caching here rather than resending is what keeps a slider drag from
 * moving a megabyte of float per frame — and holding the ID beside it is what
 * stops a stale image being used for a different one.
 */
let cachedImage: EquirectImage | null = null;
let cachedImageId = '';

/**
 * The metric set for one rig pair.
 *
 * `convergence: false` is the one bench option this page turns off. The
 * convergence check recomputes every metric at a second density to show the
 * discretisation error, which is exactly right for a report that will be read
 * once and cited, and is a 40% cost for a number that changes on every drag.
 * The page states the density instead, which is the part a reader needs.
 */
function metricsFor(
  truth: RigCalibration,
  compositor: RigCalibration,
  scene: Parameters<typeof computeGeometricMetrics>[1],
  densityScale: number,
): MetricSet {
  return computeGeometricMetrics(truth, scene, {
    contentRig: compositor,
    densityScale,
    convergence: false,
  });
}

/** Vertices across and down. Odd, so a vertex sits on the optical axis. */
const MESH_COLS = 17;
const MESH_ROWS = 11;

/**
 * How far the compositor's idea of the rig has fallen behind the rig itself:
 * the worst lens displacement in millimetres and the worst aim difference in
 * degrees, over the projectors both rigs contain.
 *
 * This is the drift, not a solver residual. It rises the moment a projector is
 * bumped and falls to the recovery error after a solve, which is exactly the
 * pair of numbers "pose off by / aim off by" wants to show — and it is ground
 * truth, so it is reported and never fed back into anything the solver sees.
 *
 * The aim comparison is between the two forward axes, which is the part of the
 * orientation a viewer can point at. Roll about the axis is a real degree of
 * freedom and it is not what "aim" means.
 */
function poseDrift(
  truth: RigCalibration,
  compositor: RigCalibration,
  slots: readonly number[],
): { positionMm: number; aimDeg: number } {
  let positionMm = 0;
  let aimDeg = 0;
  const n = Math.min(truth.projectors.length, compositor.projectors.length, slots.length);
  for (let i = 0; i < n; i++) {
    const a = truth.projectors[i].pose;
    const b = compositor.projectors[i].pose;
    positionMm = Math.max(
      positionMm,
      Math.hypot(
        a.position.x - b.position.x,
        a.position.y - b.position.y,
        a.position.z - b.position.z,
      ) * 1000,
    );
    aimDeg = Math.max(
      aimDeg,
      angleBetweenDeg(projectorBasis(a).axis, projectorBasis(b).axis),
    );
  }
  return { positionMm, aimDeg };
}

/**
 * The warp mesh for every projector. See {@link WarpMesh} for what it means.
 *
 * The composition is `worldToPixelUnbounded(truth) ∘ pixelToRay(compositor)`,
 * and both halves matter:
 *
 *  - `pixelToRay` uses the COMPOSITOR's rig because the question starts from a
 *    pixel the compositor is about to paint, in the frame it believes it is in.
 *  - `worldToPixel` uses the TRUTH rig because the answer is which pixel of the
 *    real projector puts light on that point.
 *
 * Swap either and the mesh comes out flat, which looks like a well-calibrated
 * system rather than like a bug.
 *
 * `Unbounded` on the return leg is deliberate: a vertex whose correction pushes
 * it off the edge of the raster is a real and interesting answer — it says the
 * content there cannot be corrected without losing it — and clamping to `null`
 * would draw that as a hole indistinguishable from a limb overshoot.
 */
function warpMeshes(
  truth: PreparedRig,
  compositor: PreparedRig,
  slots: readonly number[],
  slotCount: number,
): (WarpMesh | null)[] {
  const out: (WarpMesh | null)[] = Array.from({ length: slotCount }, () => null);
  const n = MESH_COLS * MESH_ROWS;
  for (let i = 0; i < compositor.projectors.length; i++) {
    const c = compositor.projectors[i];
    const t = truth.projectors[i];
    const it = c.cal.intrinsics;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const du = new Float32Array(n);
    const dv = new Float32Array(n);
    let worstPx = 0;
    let onSphere = 0;

    for (let row = 0; row < MESH_ROWS; row++) {
      for (let col = 0; col < MESH_COLS; col++) {
        const k = row * MESH_COLS + col;
        const pu = (it.resX * col) / (MESH_COLS - 1);
        const pv = (it.resY * row) / (MESH_ROWS - 1);
        u[k] = pu;
        v[k] = pv;
        du[k] = Number.NaN;
        dv[k] = Number.NaN;

        const ray = pixelToRay(c, pu, pv);
        // The sphere is centred on the world origin (conventions.ts §W), so the
        // lens position is the ray origin as it stands.
        const hit = raySphereIntersect(c.lens, ray, compositor.radiusM);
        if (!hit) continue;
        const back = t ? worldToPixelUnbounded(t, hit.point) : null;
        if (!back) continue;
        onSphere++;
        du[k] = back.u - pu;
        dv[k] = back.v - pv;
        const d = Math.hypot(du[k], dv[k]);
        if (d > worstPx) worstPx = d;
      }
    }
    out[slots[i] ?? i] = {
      projectorId: c.cal.id,
      cols: MESH_COLS,
      rows: MESH_ROWS,
      resX: it.resX,
      resY: it.resY,
      u,
      v,
      du,
      dv,
      worstPx,
      onSphere,
    };
  }
  return out;
}

/**
 * Everything the panel shows, for one request.
 *
 * Exported and free of `self` so the tests can run it: a readout the page can
 * display and no test can call is a readout nobody has ever checked.
 */
export function computeModel(req: ModelRequest): ModelResponse {
  if (req.customImage) {
    cachedImage = req.customImage;
    cachedImageId = req.customImageId;
  } else if (req.customImageId === '') {
    cachedImage = null;
    cachedImageId = '';
  }
  // A request naming an image this worker has never been sent renders the
  // fallback rather than the wrong picture. The page's parity check would catch
  // a mismatch, so the failure mode to avoid is a SILENT one.
  const custom = cachedImageId === req.customImageId ? cachedImage : null;
  const world = buildWorld(req.settings, req.compositorRig ?? undefined, custom);

  const t0 = performance.now();
  const set = metricsFor(world.truthRig, world.compositorRig, world.scene, req.densityScale);
  const metricsMs = performance.now() - t0;

  // "What the calibration bought" needs a fixed reference, and the reference is
  // the config as written — the rig an operator has before any solve. When the
  // compositor IS the config as written there is nothing to compare against and
  // the field is null rather than a duplicate of the headline number.
  let gridBaselineMm: number | null = null;
  if (req.compositorRig !== null) {
    const baseline = metricsFor(
      world.truthRig,
      world.asBuiltRig,
      world.scene,
      Math.min(req.densityScale, 0.35),
    );
    gridBaselineMm = baseline.grid.metric.value;
  }

  let parityImage: ModelResponse['parityImage'] = null;
  let parityMs = 0;
  if (req.parity) {
    const p1 = performance.now();
    const camera: ViewerCamera = {
      position: req.parity.position,
      target: req.parity.target,
      upHint: { x: 0, y: 0, z: 1 },
      fovHDeg: req.parity.fovHDeg,
      width: req.parity.width,
      height: req.parity.height,
    };
    // One sample per pixel, because that puts `sim`'s sub-pixel offset at exactly
    // the pixel centre — which is where the GPU rasterizes. Anything else would
    // make the parity number measure the sampling pattern.
    //
    // This renderer draws no floor (see its `RoomViewOptions`), so the GPU side
    // must not draw one either; `web/main.ts` turns it off for the parity pass
    // only, and the page says which part of the shader is therefore uncovered.
    const img = renderTwoRigRoomView(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.scene,
      camera,
      { samplesPerPixel: 1 },
    );
    parityMs = performance.now() - p1;
    parityImage = { width: img.width, height: img.height, data: img.data };
  }

  // Each projector's own frame — what goes down its cable. Rendered from the
  // COMPOSITOR's calibration, because that is whose arithmetic wrote it. Moving
  // a projector cannot change this picture; only a recalibration rewrites it,
  // and that is the point of showing it.
  // Indexed by PANEL SLOT, not by position in the rig — a projector switched off
  // is absent from the rig, and without this every projector after it would take
  // its neighbour's frame, its neighbour's colour and its neighbour's name.
  const slotCount = req.settings.nudge.length;
  const projectorFrames: (FrameImage | null)[] = Array.from({ length: slotCount }, () => null);
  if (req.projectorPreviewWidth > 0) {
    const compositor = prepareRig(world.compositorRig);
    const w = Math.round(req.projectorPreviewWidth);
    for (let i = 0; i < compositor.projectors.length; i++) {
      const it = compositor.projectors[i].cal.intrinsics;
      const h = Math.max(1, Math.round((w * it.resY) / it.resX));
      const img = renderProjectorView(compositor, i, world.scene, {
        samplesPerPixel: 1,
        sampleWidth: w,
        sampleHeight: h,
      });
      projectorFrames[world.slots[i] ?? i] = {
        width: img.width,
        height: img.height,
        data: img.data,
        caption: `${compositor.projectors[i].cal.id} — ${it.resX} × ${it.resY}`,
        // What goes down the cable, already through the §P encode by
        // `blendedSignal`. Not radiance.
        space: 'display',
      };
    }
  }

  // How far the compositor's idea of the rig has fallen behind the rig. This is
  // ground truth and the solver never sees it; it is here so that a bump is
  // quantified the moment it happens rather than only after a recalibration —
  // the two cells that print it used to read "— not solved" until you solved,
  // which is the one moment they both go back to nearly zero.
  const drift = poseDrift(world.truthRig, world.compositorRig, world.slots);

  return {
    kind: 'model',
    id: req.id,
    ok: true,
    driftPositionMm: drift.positionMm,
    driftAimDeg: drift.aimDeg,
    projectorFrames,
    meshes: warpMeshes(
      prepareRig(world.truthRig),
      prepareRig(world.compositorRig),
      world.slots,
      slotCount,
    ),
    projectorConfig: Array.from({ length: slotCount }, (_, slot) => {
      const i = world.slots.indexOf(slot);
      if (i < 0) return null;
      return {
        believed: projectorFacts(world.compositorRig, i),
        actual: projectorFacts(world.truthRig, i),
      };
    }),
    live: Array.from({ length: slotCount }, (_, slot) => world.slots.includes(slot)),
    readings: readingsFrom(set),
    facts: rigFacts(world.asBuiltRig, set),
    framebuffer: framebufferSentence(world.truthRig),
    gridWorstMm: set.grid.metric.value,
    gridBaselineMm,
    multiplicityAreaFraction: set.coverage.multiplicityAreaFraction,
    unlitPolarNorth: set.coverage.unlitPolarAreaFractionNorth,
    unlitPolarSouth: set.coverage.unlitPolarAreaFractionSouth,
    boundaryNorthDeg: set.coverage.boundaryLatitudeNorthDeg,
    boundarySouthDeg: set.coverage.boundaryLatitudeSouthDeg,
    scatter: set.fields.gridSamples,
    parityImage,
    parityMs,
    metricsMs,
    densityScale: req.densityScale,
  };
}
