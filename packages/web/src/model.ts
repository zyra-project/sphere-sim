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
import { prepareRig } from '../../sim/src/optics.ts';
import { computeGeometricMetrics } from '../../sim/src/metrics/index.ts';
import type { MetricSet } from '../../sim/src/metrics/index.ts';
import { renderTwoRigRoomView } from '../../sim/src/misregistration.ts';
import type { ViewerCamera } from '../../sim/src/render.ts';
import { buildWorld } from './rigs.ts';
import { framebufferSentence, readingsFrom, rigFacts } from './readout.ts';
import type { ModelRequest, ModelResponse } from './protocol.ts';

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

/**
 * Everything the panel shows, for one request.
 *
 * Exported and free of `self` so the tests can run it: a readout the page can
 * display and no test can call is a readout nobody has ever checked.
 */
export function computeModel(req: ModelRequest): ModelResponse {
  const world = buildWorld(req.settings, req.compositorRig ?? undefined);

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

  return {
    kind: 'model',
    id: req.id,
    ok: true,
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
