// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 7: does a facet normal cost anything where the facets ARE the body?
 *
 * ## The cell, and why it is the one that isolates the question
 *
 * `docs/ARBITRARY-SHAPES.md` reads the tessellated sphere's error as a Jacobian
 * defect: "a flat facet normal is the derivative of the facet, not of the
 * surface the facets approximate, so every step carries a Jacobian error that
 * changes at each facet edge." A later entry measures a competing explanation —
 * MODEL error, the facets simply not being the body — by photographing the
 * analytic sphere and fitting a mesh inscribed in it, and finds the cost
 * monotone in tessellation there and the stalls gone.
 *
 * The two explanations are not separable in that cell, because both are present:
 * the derivative is the facet's AND the facets are not the photographed body.
 *
 * The bench's mesh scenario is the cell that separates them. `buildWorld` makes
 * ONE mesh and hands it to both sides — the cameras photograph it and the bundle
 * fits it — so the facets are not an approximation of anything. They are the
 * truth. MODEL ERROR IS ZERO BY CONSTRUCTION, and anything a coarser
 * tessellation still costs there is the derivative or the conditioning, because
 * there is nothing else left for it to be.
 *
 * That is the claim everything below rests on, so it was CHECKED rather than
 * assumed, in each of the three places a sphere could have leaked back in.
 * `buildWorld` builds one `ellipsoidMesh` and derives both `surface` (what
 * `captureAndDecode` photographs) and `meshIndex` (what the bundle fits) from
 * that one object. The decoder's segmenter, where the scenario has one, is
 * `meshSegmenter` against that same `meshIndex` and never `sphereSegmenter` —
 * `run.ts` reasserts it on the mesh branch precisely so a caller's sphere
 * predicate cannot reach a mesh. And every branch in `run.ts` that could choose
 * between the two bodies keys on `surface === null`, never on the archetype's
 * name, so building these arms from `nominal` does not take a sphere path.
 *
 * That makes the prediction sharp in both directions. If the facet normal is
 * what costs something, the cost falls as facets flatten toward the surface, and
 * `smooth` — which swaps the derivative and nothing else — recovers it where the
 * facets are coarsest. If it is not, the cost is flat in tessellation and
 * `smooth` buys nothing, or costs something, since in this cell it describes a
 * curve that genuinely is not there.
 *
 * ## WHICH COMPARISON IS CLEAN, because only one of the two is
 *
 * The record calls the tessellated sphere against the analytic sphere "the
 * cleanest comparison in the table, since it changes the representation and
 * nothing else". It does not. The analytic row photographs a SPHERE and fits a
 * sphere; the mesh row photographs a MESH and fits that mesh. The two rows have
 * different bodies — an inscribed 64x128 tessellation is smaller than the sphere
 * it is inscribed in by the sagitta, everywhere — so the difference between them
 * is the representation AND the body at once, which is two things.
 *
 * This experiment inherits that confound in its `vs control` column and cannot
 * remove it: a control with no facets is the only floor there is. What it can do
 * is MEASURE it, which `radiusDeficitMm` does by walking the facets of the mesh
 * the solve used. Against the rig's 0.8636 m sphere, mean and deepest deficit at
 * a triangle centroid:
 *
 *   64x128   0.349 mm mean, 0.462 mm deepest
 *   96x192   0.155        , 0.206
 *   128x256  0.087        , 0.116
 *   192x384  0.039        , 0.051
 *
 * — falling as the square of the refinement, exactly as a chord should, and the
 * 0.349 at 64x128 agreeing with the 0.218 mm the record measured independently
 * for its midsurface mesh, which is the same quantity taken area-weighted rather
 * than at centroids.
 *
 * WHAT THAT NUMBER DOES AND DOES NOT BOUND. It bounds the scene difference in
 * millimetres of surface: half a millimetre at the coarsest rung, fifty microns
 * at the finest, against pose errors of eleven to twenty-two millimetres. It
 * does NOT bound how that propagates into a recovered pose, which nothing here
 * measures — a surface displaced by half a millimetre need not move a projector
 * by half a millimetre, and could move it by more. And it says nothing at all
 * about rotation, which has no millimetres to be compared against.
 *
 * Note also what is NOT a confound here, because it is in the record's cell and
 * not this one. There, the mesh is inscribed in the body the cameras saw, so the
 * solver fits a systematically small surface — a scale BIAS, which the record's
 * midsurface mesh was built to remove and which it refuted as a mechanism. Here
 * every arm fits exactly the body its own cameras photographed. There is no bias
 * in any arm's fit; there is only the fact that the analytic arm and a mesh arm
 * are solving slightly different scenes.
 *
 * The column is still reported because a reader needs a scale, and it is still
 * NOT the evidence for anything about the derivative.
 *
 * THE MECHANISM PAIRS ARE THE CLEAN ONES. `64x128` against `64x128-smooth` is
 * the same mesh, the same photographs, the same correspondences and the same
 * starting rig, with one thing different: which normal the bundle differentiates
 * the hit against. Nothing about the body moves. Every claim this experiment
 * makes about the facet normal rests on those pairs and on the shift-known arms
 * that say what a gap in them is made of — never on a ratio against the control.
 *
 * ## What this does NOT re-measure, and one comparison it must not make
 *
 * Facet against smooth in the REALISTIC cell is settled: 540 solves over 60
 * paired seeds, smooth winning 152 of 180 paired rows on rotation with the
 * crease guard in place. This is a different cell and a different question, and
 * nothing here revisits the shipped default.
 *
 * And the document's own headline figures — the tessellated sphere at 32-137 mm
 * against the analytic 8-17 — are on THE PAGE's configuration: three cameras at
 * 320x240, sensor noise, `errorSeed` 1-3, the mesh at the rig's 0.864 m. This
 * sweep is on the bench's `nominal` archetype at bench seeds. The word "seed"
 * means a different thing in each and the rigs are not the same rig, so no row
 * here may be set against a row there. An earlier draft of this file did exactly
 * that — read 22.3 mm against the recorded 137.4 and called the difference a
 * solver change — which is the fault this whole branch has been removing: a
 * cause asserted where nobody had established one. The two worst recorded rows
 * did run to the 400-iteration cap, and that IS in the record's own caption;
 * what does not follow is that the cap explains the difference from a number
 * measured somewhere else.
 */

/** Root seed for this experiment's scenario seeds. Never a bench seed. */
export const EXPERIMENT_ROOT_SEED = 20260912;

/**
 * Twelve. Smaller than experiment 6's thirty because the effect being separated
 * here is a factor rather than a few percent, and each point costs about a
 * minute against experiment 6's twenty seconds. The number that matters is the
 * PAIRING: every arm sees the same twelve rigs, so the comparison is within a
 * seed and seed variance cancels out of it.
 */
export const SEED_COUNT = 12;

/**
 * Bench seed 1 as well, and flagged, so the sweep can be re-derived from one
 * cheap run.
 *
 * NOT the record's seed. `docs/ARBITRARY-SHAPES.md` reports `errorSeed` 1-3 on
 * the page's configuration; this is `makeScenario(1, nominal, …)` on the bench's.
 * Same numeral, different rig, and nothing here is comparable to a row there.
 */
export const DOCUMENTED_SEEDS = [1] as const;

/**
 * The shift-known arms' prior width, experiment 6's `TIGHT_SIGMA` and for its
 * reasons: `ParameterPrior` rejects a zero width, so one order below the
 * N(0, 0.01·scale) the truth is drawn from is the tightest honest statement, and
 * it is a soft penalty rather than a hold.
 */
export const TIGHT_SIGMA = 1e-3;

export interface Arm {
  key: string;
  question: string;
  /** null = the analytic sphere: the control, and the only arm with no facets. */
  grid: { nLat: number; nLon: number } | null;
  meshNormal: 'facet' | 'smooth';
  /**
   * Hand the solver the TRUE lens shift and pin it there with `TIGHT_SIGMA`.
   *
   * Both halves or neither, which is A-18's correction to A-16: `solve` centres
   * the shift prior on the nominal it is given, and §3.1's nominal shift is
   * zero while the truth is drawn from N(0, 0.01·scale), so a tight sigma ALONE
   * holds the parameter at a value known to be wrong and measures whether the
   * wrong value hurts rather than whether the parameter is degenerate.
   *
   * Never a shipped configuration. It is here because experiment 6 found the
   * bench mesh scenario's rotation error to be A-12's shift degeneracy rather
   * than anything about the mesh, and the same explanation is available for any
   * gap this experiment finds between the two normals — two calibrations far
   * apart fitting the same photographs, with the derivative merely deciding
   * WHICH of them the optimiser lands on. If the gap survives the degeneracy
   * being removed it is about the derivative; if it collapses, it never was.
   */
  shiftKnown?: boolean;
}

export const ARMS: readonly Arm[] = [
  {
    key: 'analytic',
    question:
      'The control. The same rig, the same cameras and the same photons, with the body a sphere ' +
      'the solver intersects in closed form — the floor a tessellation of it is measured against.',
    grid: null,
    meshNormal: 'facet',
  },
  {
    key: '64x128',
    question:
      "The bench mesh scenario's own grid, and the coarsest rung here: the facet normal is " +
      'furthest from the surface it stands in for, so a derivative effect is largest.',
    grid: { nLat: 64, nLon: 128 },
    meshNormal: 'facet',
  },
  {
    key: '64x128-smooth',
    question:
      'THE MECHANISM TEST WHERE IT SHOULD SHOW. The same body and the same photographs with the ' +
      'derivative swapped for the interpolated normal. If the facet normal is what costs ' +
      'something, this is the rung that recovers it.',
    grid: { nLat: 64, nLon: 128 },
    meshNormal: 'smooth',
  },
  {
    key: '96x192',
    question: 'One step finer, to tell a trend from a step.',
    grid: { nLat: 96, nLon: 192 },
    meshNormal: 'facet',
  },
  {
    key: '128x256',
    question: 'Finer again. Facets flatten as the square of the refinement; the cost should follow.',
    grid: { nLat: 128, nLon: 256 },
    meshNormal: 'facet',
  },
  {
    key: '192x384',
    question:
      'The finest rung, where a facet normal is closest to the surface normal and the derivative ' +
      'explanation has the least room left.',
    grid: { nLat: 192, nLon: 384 },
    meshNormal: 'facet',
  },
  {
    key: '192x384-smooth',
    question:
      'THE MECHANISM TEST WHERE IT SHOULD NOT. Smoothing at the finest rung buys almost no ' +
      'accuracy in the derivative and still describes a curve this cell does not have. A gain ' +
      'here as large as at 64x128 would mean the effect is not about facet coarseness at all.',
    grid: { nLat: 192, nLon: 384 },
    meshNormal: 'smooth',
  },
  {
    key: 'analytic-shift-known',
    question:
      "The floor with A-12's degeneracy removed, because the mesh arms' floor has to move with " +
      'them or the comparison is against the wrong control.',
    grid: null,
    meshNormal: 'facet',
    shiftKnown: true,
  },
  {
    key: '64x128-shift-known',
    question: "The coarsest rung with the shift degeneracy removed: half of the gap's control.",
    grid: { nLat: 64, nLon: 128 },
    meshNormal: 'facet',
    shiftKnown: true,
  },
  {
    key: '64x128-smooth-shift-known',
    question:
      'THE ARM THAT DECIDES WHAT THE GAP IS. If facet and smooth agree once the degenerate ' +
      'direction is pinned, the normal was choosing a point along it rather than fitting better, ' +
      'and no claim about the derivative survives.',
    grid: { nLat: 64, nLon: 128 },
    meshNormal: 'smooth',
    shiftKnown: true,
  },
];
