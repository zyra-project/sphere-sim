// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The SOS projector alignment file — a reader, a writer, and the reduction that
 * turns this repository's warp into one.
 *
 * ## Provenance, which is the first thing to know about this module
 *
 * There is no published grammar for this format in anything PARAMETERS.md
 * cites. Everything here rests on two sources, and both are named so a reader
 * can weigh them:
 *
 *   1. **One sample file** a site sent over. Nine numbered points and a global
 *      affine. One file, one site, one projector.
 *   2. **An account from an SOS developer**, relayed second-hand: SOS renders
 *      each projector's scene to a framebuffer and then draws that texture onto
 *      a 3x3 mesh whose texture coordinates are FIXED at (0,0), (0.5,0) ... (1,1)
 *      and whose nine vertex POSITIONS are what the file carries
 *      (`ViewportWarper.cc:403`). `translate`, `scale` and `rotate` are global
 *      geometric transforms applied around that mesh.
 *
 * That is enough to write a file with confidence about its MEANING and not about
 * its every convention. The specific things still inferred rather than known are
 * listed under "Inferences" below, each with the observation that supports it.
 * The parser refuses what it does not recognise instead of guessing, and the
 * writer emits the narrowest file that can express the answer.
 *
 * ## The format
 *
 *     translate 0.026 -0.003
 *     scale 1.06606 1.06393
 *     rotate -0.7
 *     1 -0.992 0.998
 *     ... nine of them, 1-based ...
 *
 * ## This is NOT Bourke's warp mesh, and the difference is not the one it looks
 *
 * `warp.ts` writes Bourke's format: per node, a display position AND a texture
 * coordinate AND an intensity. It is tempting to summarise the difference as
 * "SOS has no texture coordinates, so it cannot resample". **That is wrong**, and
 * it is worth saying so here because it is the natural mistake and it leads
 * somewhere: SOS resamples perfectly well. Its texture coordinates are fixed at
 * the canonical grid and interpolated across the deformed triangles, which is a
 * resample by any definition. Bourke's own specification says a warp may live
 * "in either the x,y coordinates or in the u,v coordinates or in both"; for a
 * mesh warp those are duals, and SOS simply pins one half and varies the other.
 *
 * The true differences are three, and they are what "information loss" means
 * everywhere below:
 *
 *   1. **Nine control points.** Four bilinear cells over the whole frame. Any
 *      correction that is not piecewise-bilinear on a 2x2 partition — every lens
 *      distortion, and every warp that changes sign more than once across the
 *      frame — is not representable, at any precision.
 *   2. **No independent texture map.** The UVs are pinned to the grid, so the
 *      only warps expressible are the images of vertex displacements. Bourke can
 *      state a per-node correspondence that no vertex displacement produces.
 *   3. **No intensity.** Bourke's fifth column carries the blend. Nothing in an
 *      alignment file does: SOS blends elsewhere, procedurally, in a separate
 *      subsystem (edge masks in `EdgeBlend.cc:217`; a shader curve parameterised
 *      by `SOS_BLEND_P` / `SOS_BLEND_G` / `SOS_BLEND_A` in `BlendBelt.cc:42`).
 *      So a file written here carries geometry ONLY, and the blend
 *      `buildWarpExport` computes has nowhere to go. See PARAMETERS.md §4.5.
 *
 * {@link buildSosAlignment} measures 1 rather than asserting it: the residual it
 * reports is exactly what the nine points could not express.
 *
 * ## Which displacement this writes, which is the other easy way to be wrong
 *
 * Bourke's mesh answers "which texel of the CONTENT belongs at this node". An
 * SOS alignment answers something else entirely: its texture is the projector's
 * own already-rendered framebuffer, so it answers "where on screen does the
 * pixel the software drew here actually have to go".
 *
 * That second question is the two-rig disagreement — the same quantity
 * `packages/web/src/model.ts`'s `warpMeshes` draws — and NOT the content map
 * `buildWarpExport` writes. Deriving one from the other is not a matter of
 * dropping columns:
 *
 *   - Inverting the Bourke file would ask "where on the display does content
 *     texel (0, 0) go", and for a projector that sees a quarter of a sphere the
 *     answer is nowhere. Every corner of the grid would be undefined.
 *   - Reading the Bourke node positions as SOS vertex positions would write the
 *     identity: those positions ARE the undeformed raster.
 *
 * So this takes two rigs, like `warpMeshes` and unlike `buildWarpExport`: what
 * the software believes, and what is true. With one rig the answer is the
 * identity, correctly and uselessly.
 *
 * ## Inferences, each with what supports it
 *
 *   - **Both axes span ±1**, unlike Bourke's ±aspect on x. The sample reaches
 *     1.006 and -1.01 on x and 0.998 and -1.01 on y; a 16:9 frame in Bourke's
 *     convention would reach ±1.778 on x. Getting this backwards squeezes or
 *     stretches every non-square projector by the aspect ratio and produces a
 *     picture that is plainly a picture — see `warp.ts` on the same hazard.
 *   - **Vertices are row-major from the TOP-left.** The sample's point 1 sits at
 *     (-0.992, +0.998) and its point 9 at (1.006, -0.986), so the index advances
 *     left-to-right and then downward in a y-up frame. This pairs vertex 1 with
 *     raster pixel (0, 0) under conventions.ts §I, where raster v runs down.
 *   - **The identity file is the untweaked grid**, so a displacement is measured
 *     against it. No coordinate in the sample is more than 0.014 from where the
 *     untweaked grid puts it — a seventh of one cell — which is what makes "the
 *     identity, nudged" the reading rather than "an arbitrary mesh".
 *
 * What is NOT inferred, because it does not have to be: the composition order of
 * `translate`, `scale` and `rotate` against the mesh. {@link buildSosAlignment}
 * writes the identity affine and puts the whole correction in the nine vertices,
 * which is the same file under every order. The affine that WOULD have been
 * equivalent is reported beside the file as a diagnostic — it is the number
 * comparable to a site's own alignment file — and deliberately not written into
 * it, because a guessed order is a silently wrong file.
 */

import type { PreparedRig } from './optics.ts';
import { pixelToRay, worldToPixelUnbounded } from './optics.ts';

/** One control point. */
export interface SosVertex {
  /** The file's own 1-based index, kept so a round trip preserves order. */
  index: number;
  x: number;
  y: number;
}

/** A parsed or generated alignment file. */
export interface SosAlignment {
  translate: { x: number; y: number };
  scale: { x: number; y: number };
  /** Degrees in the sample — small, and consistent with §2's mount tolerance. */
  rotateDeg: number;
  vertices: SosVertex[];
  /** Side of the square grid, from the count. 3 in everything SOS reads. */
  gridSide: number;
  /** Lines the parser did not recognise, verbatim, with 1-based line numbers. */
  unrecognised: { line: number; text: string }[];
}

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function nums(parts: string[], want: number, line: number, what: string): number[] {
  if (parts.length !== want) {
    throw new Error(`line ${line}: ${what} wants ${want} numbers, got ${parts.length}`);
  }
  return parts.map((p) => {
    if (!NUM.test(p)) throw new Error(`line ${line}: ${what} got a non-number ${JSON.stringify(p)}`);
    const v = Number(p);
    // The grammar admits `1e999`, which `Number` makes Infinity. Refused here
    // rather than left to become a NaN four functions away: this parser's whole
    // promise is a message naming the line, and an infinity keeps that promise
    // only if it is caught while the line number is still in hand.
    if (!Number.isFinite(v)) {
      throw new Error(`line ${line}: ${what} got ${JSON.stringify(p)}, which is not a finite number`);
    }
    return v;
  });
}

/**
 * Read an alignment file.
 *
 * Strict on everything it claims to understand and silent on everything else:
 * an unrecognised line is kept verbatim in {@link SosAlignment.unrecognised}
 * rather than dropped or guessed at. With one sample and no grammar, a line this
 * parser has never seen is far more likely to be a real directive than a typo,
 * and a reader that discards it would make the file look simpler than it is.
 */
export function parseSosAlignment(text: string): SosAlignment {
  let translate: { x: number; y: number } | null = null;
  let scale: { x: number; y: number } | null = null;
  let rotateDeg: number | null = null;
  const vertices: SosVertex[] = [];
  const unrecognised: { line: number; text: string }[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) return;
    const parts = t.split(/\s+/);
    const head = parts[0].toLowerCase();
    const rest = parts.slice(1);
    if (head === 'translate') {
      const [x, y] = nums(rest, 2, line, 'translate');
      translate = { x, y };
    } else if (head === 'scale') {
      const [x, y] = nums(rest, 2, line, 'scale');
      scale = { x, y };
    } else if (head === 'rotate') {
      [rotateDeg] = nums(rest, 1, line, 'rotate');
    } else if (NUM.test(head)) {
      // A vertex line: index, then position. The index is NOT assumed to equal
      // the row order — it is read and checked, because a file that renumbered
      // its points would otherwise be silently misread as being in order.
      const [index, x, y] = nums(parts, 3, line, 'a vertex');
      if (!Number.isInteger(index) || index < 1) {
        throw new Error(`line ${line}: vertex index ${index} is not a positive integer`);
      }
      vertices.push({ index, x, y });
    } else {
      unrecognised.push({ line, text: t });
    }
  });

  if (translate === null) throw new Error('no translate line');
  if (scale === null) throw new Error('no scale line');
  if (rotateDeg === null) throw new Error('no rotate line');
  if (vertices.length === 0) throw new Error('no vertices');

  const seen = new Set(vertices.map((v) => v.index));
  if (seen.size !== vertices.length) throw new Error('duplicate vertex indices');
  for (let i = 1; i <= vertices.length; i++) {
    if (!seen.has(i)) throw new Error(`vertex indices are not 1..${vertices.length} (missing ${i})`);
  }
  const gridSide = Math.round(Math.sqrt(vertices.length));
  if (gridSide * gridSide !== vertices.length) {
    throw new Error(`${vertices.length} vertices is not a square grid`);
  }
  return { translate, scale, rotateDeg, vertices, gridSide, unrecognised };
}

/**
 * Where the untweaked grid puts vertex `k`, 0-based, in the ±1 frame.
 *
 * Row-major from the TOP-left — see the module note on why that ordering is the
 * sample's and not a choice made here.
 */
export function sosIdentityVertex(k: number, gridSide: number): { x: number; y: number } {
  if (gridSide < 2) return { x: 0, y: 0 };
  const col = k % gridSide;
  const row = Math.floor(k / gridSide);
  return { x: -1 + (2 * col) / (gridSide - 1), y: 1 - (2 * row) / (gridSide - 1) };
}

/** Each vertex's displacement from where the untweaked grid would put it. */
export function vertexDisplacements(
  alignment: SosAlignment,
): { index: number; dx: number; dy: number }[] {
  return [...alignment.vertices]
    .sort((a, b) => a.index - b.index)
    .map((v, k) => {
      const id = sosIdentityVertex(k, alignment.gridSide);
      return { index: v.index, dx: v.x - id.x, dy: v.y - id.y };
    });
}

/**
 * Serialize an alignment file.
 *
 * Six decimals throughout, where the sample carries between zero and five. The
 * sample's precision is an operator's keystrokes; six decimals on a ±1 axis
 * resolves about a thousandth of a pixel on a 1920 raster, which is past
 * anything a nine-point mesh can act on and costs a few bytes.
 *
 * Unrecognised lines from a parsed file are NOT re-emitted. This writes files it
 * generated; round-tripping a file whose unknown directives might interact with
 * the ones here would be a guess about semantics nobody has.
 */
export function formatSosAlignment(alignment: SosAlignment): string {
  const out: string[] = [
    `translate ${f(alignment.translate.x)} ${f(alignment.translate.y)}`,
    `scale ${f(alignment.scale.x)} ${f(alignment.scale.y)}`,
    `rotate ${f(alignment.rotateDeg)}`,
  ];
  for (const v of [...alignment.vertices].sort((a, b) => a.index - b.index)) {
    out.push(`${v.index} ${f(v.x)} ${f(v.y)}`);
  }
  return `${out.join('\n')}\n`;
}

function f(value: number): string {
  // Fixed rather than `toPrecision`, which gives exponent form for small numbers
  // — and every number in this file is small. Whether the site's reader accepts
  // an `e` is exactly the kind of thing one sample cannot say.
  const s = value.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
}

/**
 * The affine that the nine vertices amount to, reported rather than written.
 *
 * Decomposed as translate, then rotate, then a scale with shear — the reading a
 * `translate`/`scale`/`rotate` triple invites. SOS's own composition order is
 * unknown (module note), so this is a description of the fit and not a
 * prescription for the file. `shear` is the part no three-parameter affine can
 * carry, and a non-negligible value is itself the finding.
 *
 * **In WHICH frame** is not a detail. The file's frame spans ±1 on both axes,
 * so on a 16:9 projector it compresses x against y by 16/9, and an angle in it
 * is not an angle on the wall. A physical roll of 1 degree decomposes in the
 * file's frame as 1.777 degrees with 0.021 of shear — inflated by exactly the
 * aspect ratio, because conjugating a rotation by a non-uniform scale is not a
 * rotation. Read the other way round, and IF SOS composes `rotate` in the same
 * normalized frame its vertices live in, the sample's `rotate -0.7` is about
 * -0.39 degrees of actual image rotation.
 *
 * So {@link SosAlignmentExport} reports the decomposition twice. Neither is
 * redundant: one is comparable to a site's own file, the other says what the
 * correction physically is.
 */
export interface SosAffine {
  translate: { x: number; y: number };
  scale: { x: number; y: number };
  rotateDeg: number;
  shear: number;
}

/** What the reduction to nine points cost, in pixels of the projector's raster. */
export interface SosResidual {
  /** Samples whose ray reached the body. The fit is over these and only these. */
  samples: number;
  /** Samples attempted, hit or miss. */
  attempted: number;
  /** The displacement field itself: what a perfect warp would have to correct. */
  fieldRmsPx: number;
  fieldMaxPx: number;
  /** What is left after the global affine alone. */
  affineRmsPx: number;
  affineMaxPx: number;
  /** What is left after the affine AND the nine points. The file's own error. */
  meshRmsPx: number;
  meshMaxPx: number;
}

export interface SosAlignmentExport {
  projectorId: string;
  /** The file to write. Identity affine; the whole correction in the vertices. */
  alignment: SosAlignment;
  /**
   * The fit read in the file's own ±1 frame — the numbers comparable to a
   * site's `translate`/`scale`/`rotate` line. Diagnostic only, never written.
   */
  equivalentAffine: SosAffine;
  /**
   * The same fit read at the projector's real pixel aspect: what the correction
   * physically is. A pure roll comes back here as a rotation with unit scale and
   * no shear, which in {@link SosAlignmentExport.equivalentAffine} it does not.
   */
  screenAffine: SosAffine;
  residual: SosResidual;
  /**
   * Per-vertex share of the data that constrained it, largest normalised to 1.
   *
   * A vertex near zero had no samples in either adjacent cell — the projector's
   * light never reaches that corner of its own frame, which is the normal case
   * for a projector that overshoots the body — and its position is the affine's
   * extrapolation rather than anything measured.
   */
  vertexSupport: number[];
  /** 1-based indices of vertices that land outside the ±1 frame. */
  outOfFrame: number[];
}

export interface SosOptions {
  /** Samples across and down the raster for the fit. */
  samples?: number;
  /**
   * Control points per side. 3 is what SOS reads; anything else is a measurement
   * of what a finer mesh WOULD buy and is not a file SOS can load.
   */
  gridSide?: number;
}

/**
 * Reduce one projector's two-rig disagreement to an SOS alignment file.
 *
 * ## What is fitted, and why in two stages
 *
 * Sample the raster; for each pixel the software would draw, ask where the light
 * actually has to leave the projector; that difference is the field. Then fit,
 * in this order:
 *
 *   1. **A global affine** over the whole field. Six parameters, least squares.
 *   2. **The nine control points** over what the affine left, on the
 *      piecewise-bilinear basis SOS itself evaluates — so the fit is done in
 *      exactly the space the file can express, and the leftover is exactly what
 *      the format cannot say.
 *
 * The two stages are not a refinement of one model; they are what makes the
 * corners answerable. A projector overshoots the body it lights, so the corner
 * pixels of its own raster reach nothing and no sample constrains the corner
 * vertices. Fitting the mesh alone would leave those four unconstrained, and the
 * only honest fallback — leave them at the identity — is wrong in the common
 * case: a field that is mostly a uniform scale should move the corners most of
 * all, and pinning them would write a barrel distortion that is not there.
 * Fitting the affine first means an unconstrained corner inherits the global
 * trend, which is the correct extrapolation and the one an operator would dial
 * in by hand. {@link SosAlignmentExport.vertexSupport} says which vertices those
 * were, so a reader is never told a measurement was made when it was not.
 *
 * A small ridge holds the second stage down where support is thin. It is scaled
 * to the best-constrained vertex, so it is negligible wherever data exists and
 * decisive only where none does.
 *
 * ## Which rig is which
 *
 * `compositor` is the calibration the software believes — the config as written,
 * or what a solve recovered. `truth` is the rig the light actually leaves. The
 * file corrects the first towards the second, which is only meaningful when they
 * differ: with the same rig twice every displacement is zero and this writes the
 * identity grid, correctly.
 */
export function buildSosAlignment(
  truth: PreparedRig,
  compositor: PreparedRig,
  index: number,
  options: SosOptions = {},
): SosAlignmentExport {
  const c = compositor.projectors[index];
  if (!c) throw new Error(`no projector at index ${index} in the compositor rig`);
  // Paired by IDENTITY, not by array position. A rig with a projector switched
  // off is shorter and the rest keep their slot names, so a compositor holding
  // [P1, P3] against a truth rig holding [P1, P2, P3] lines P3 up with P2 at
  // index 1 — and every step after this is arithmetic that works perfectly on
  // the wrong lens. The file it writes is well-formed and corrects a projector
  // towards somewhere the light never goes.
  const t = truth.projectors.find((p) => p.cal.id === c.cal.id);
  if (!t) {
    throw new Error(
      `the truth rig has no projector ${c.cal.id}; it holds ` +
        `${truth.projectors.map((p) => p.cal.id).join(', ') || 'none'}`,
    );
  }

  const gridSide = Math.max(2, Math.floor(options.gridSide ?? 3));
  const n = gridSide * gridSide;
  const steps = Math.max(gridSide, Math.floor(options.samples ?? 41));
  const it = c.cal.intrinsics;

  // ------------------------------------------------------------------ sample
  const X: number[] = [];
  const Y: number[] = [];
  const dx: number[] = [];
  const dy: number[] = [];
  let attempted = 0;

  for (let row = 0; row < steps; row++) {
    for (let col = 0; col < steps; col++) {
      attempted++;
      const pu = (it.resX * col) / (steps - 1);
      const pv = (it.resY * row) / (steps - 1);
      // What the software believes this pixel lights, on the surface it believes.
      const hit = compositor.surface.intersect(c.lens, pixelToRay(c, pu, pv));
      if (hit === null) continue;
      // Where the real projector must address to light that same point.
      const back = worldToPixelUnbounded(t, hit.point);
      if (back === null) continue;
      // Raster v runs DOWN (conventions.ts §I) and the frame's y runs UP, so the
      // vertical displacement changes sign on the way in. This is the flip
      // `warp.ts` warns about, in the one place here that can make it.
      X.push((pu / it.resX) * 2 - 1);
      Y.push(1 - (pv / it.resY) * 2);
      dx.push(((back.u - pu) / it.resX) * 2);
      dy.push((-(back.v - pv) / it.resY) * 2);
    }
  }

  const samples = X.length;
  const toPx = (rx: number, ry: number): number =>
    Math.hypot((rx / 2) * it.resX, (ry / 2) * it.resY);

  const field = magnitudes(dx, dy, toPx);
  if (samples === 0) {
    // Nothing this projector addresses reaches the body. The identity grid is
    // the only defensible file: there is no measurement to reduce.
    return identityExport(c.cal.id, gridSide, attempted);
  }

  // ------------------------------------------------------- stage 1, the affine
  // Basis [1, X, Y] on the ±1 frame, so the coefficients read directly as a
  // translation and a linear part.
  const aRows = X.map((_, i) => [1, X[i], Y[i]]);
  const affX = leastSquares(aRows, dx, 3, 0);
  const affY = leastSquares(aRows, dy, 3, 0);
  if (affX === null || affY === null) {
    // Collinear or degenerate support — a projector grazing the body can produce
    // it. Fall back to the mesh stage alone rather than inventing a trend.
    return fitMeshOnly(c.cal.id, gridSide, attempted, X, Y, dx, dy, toPx, field);
  }

  const rx = X.map((_, i) => dx[i] - (affX[0] + affX[1] * X[i] + affX[2] * Y[i]));
  const ry = X.map((_, i) => dy[i] - (affY[0] + affY[1] * X[i] + affY[2] * Y[i]));
  const afterAffine = magnitudes(rx, ry, toPx);

  // --------------------------------------------------- stage 2, the nine points
  // Fitted against BOTH triangle splits at once and scored against the worse of
  // them — see {@link basisRow}. Committing to one diagonal and guessing wrong
  // costs two to four times as much as not committing.
  const fit = fitMesh(X, Y, rx, ry, gridSide);
  const afterMesh = worstResidual(X, Y, rx, ry, fit, gridSide, toPx);
  const { meshX, meshY, support, peak } = fit;

  // ------------------------------------------------------------------- assemble
  const vertices: SosVertex[] = [];
  const outOfFrame: number[] = [];
  for (let k = 0; k < n; k++) {
    const id = sosIdentityVertex(k, gridSide);
    const x = id.x + (affX[0] + affX[1] * id.x + affX[2] * id.y) + meshX[k];
    const y = id.y + (affY[0] + affY[1] * id.x + affY[2] * id.y) + meshY[k];
    vertices.push({ index: k + 1, x, y });
    // Not clamped. A vertex outside the frame is the file asking for content the
    // frame does not hold — the projector cannot address it, so the correction is
    // beyond what any warp can deliver. Two of the sample file's nine points are
    // in that state, so it is a real configuration and not an error here; it is
    // reported instead.
    if (Math.abs(x) > 1 || Math.abs(y) > 1) outOfFrame.push(k + 1);
  }

  return {
    projectorId: c.cal.id,
    alignment: {
      // Identity. The whole correction rides in the vertices — module note.
      translate: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotateDeg: 0,
      vertices,
      gridSide,
      unrecognised: [],
    },
    equivalentAffine: decomposeAffine(affX, affY),
    screenAffine: decomposeAffine(affX, affY, 1 / displayAspect(it)),
    residual: {
      samples,
      attempted,
      fieldRmsPx: field.rms,
      fieldMaxPx: field.max,
      affineRmsPx: afterAffine.rms,
      affineMaxPx: afterAffine.max,
      meshRmsPx: afterMesh.rms,
      meshMaxPx: afterMesh.max,
    },
    vertexSupport: peak > 0 ? support.map((s) => s / peak) : support,
    outOfFrame,
  };
}

/** One control point, read against a raster. */
export interface SosVertexReading {
  index: number;
  /** Where the file puts it, in the ±1 frame. */
  x: number;
  y: number;
  /** How far the file moved it from the untweaked grid, in raster pixels. */
  dxPx: number;
  dyPx: number;
  magnitudePx: number;
  /** True when it asks for content the frame does not hold. */
  outOfFrame: boolean;
}

/** A parsed alignment file, read back into quantities with units. */
export interface SosReading {
  /** The raster it was read against. Wrong raster, wrong pixels. */
  resX: number;
  resY: number;
  /** Control points per side, carried through so a caller can draw the grid. */
  gridSide: number;
  /** `translate`, in raster pixels. */
  translatePx: { x: number; y: number };
  /**
   * `scale`, unchanged. A diagonal scale is the one part of the affine that
   * reads the same in the file's frame and on the wall, because conjugating a
   * diagonal matrix by a diagonal matrix returns it.
   */
  scale: { x: number; y: number };
  /** `rotate` as the file writes it, in the ±1 frame. */
  rotateDeg: number;
  /**
   * `rotate` read as an angle on the wall.
   *
   * CONDITIONAL, and the condition is not knowable from one sample: it assumes
   * SOS applies `rotate` in the same normalized frame its vertices live in. If
   * it does, then because that frame spans ±1 on both axes while the display
   * does not, `tan` of the angle is divided by the display aspect — so on a
   * 16:9 projector a file saying 1.777 is doing one degree.
   */
  rotateDegOnScreen: number;
  vertices: SosVertexReading[];
  /** The largest control-point move, in raster pixels. */
  worstPx: number;
  /** How many control points ask for content outside the frame. */
  outOfFrameCount: number;
  /** Lines the parser did not recognise, carried through verbatim. */
  unrecognised: { line: number; text: string }[];
}

/**
 * Read a parsed alignment file back into quantities that have units.
 *
 * The file is dimensionless — a ±1 frame and an angle in it — so on its own it
 * says how much of the frame a correction uses and not how much of a projector.
 * Everything here is that same content against a raster: the translation and the
 * control points in pixels, the rotation in degrees on the wall.
 *
 * **The raster has to be the one the file was written for.** A file from a site
 * running 1920x1200 read against a 1920x1080 projector produces vertical numbers
 * that are wrong by 11% and look entirely plausible. Nothing in the file says
 * which raster it came from, so nothing here can check it; the caller has to
 * know, and a caller showing these numbers should say which raster it used.
 */
export function readSosAlignment(
  alignment: SosAlignment,
  raster: { resX: number; resY: number; pixelAspect?: number },
): SosReading {
  const it = { resX: raster.resX, resY: raster.resY, pixelAspect: raster.pixelAspect ?? 1 };
  const aspect = displayAspect(it);
  const rad = (alignment.rotateDeg * Math.PI) / 180;
  const sorted = [...alignment.vertices].sort((a, b) => a.index - b.index);

  let worstPx = 0;
  let outOfFrameCount = 0;
  const vertices = sorted.map((v, k) => {
    const id = sosIdentityVertex(k, alignment.gridSide);
    const dxPx = ((v.x - id.x) / 2) * it.resX;
    const dyPx = ((v.y - id.y) / 2) * it.resY;
    const magnitudePx = Math.hypot(dxPx, dyPx);
    const outOfFrame = Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
    if (magnitudePx > worstPx) worstPx = magnitudePx;
    if (outOfFrame) outOfFrameCount++;
    return { index: v.index, x: v.x, y: v.y, dxPx, dyPx, magnitudePx, outOfFrame };
  });

  return {
    resX: it.resX,
    resY: it.resY,
    gridSide: alignment.gridSide,
    translatePx: {
      x: (alignment.translate.x / 2) * it.resX,
      y: (alignment.translate.y / 2) * it.resY,
    },
    scale: { ...alignment.scale },
    rotateDeg: alignment.rotateDeg,
    // `atan2` on the two components rather than `atan` of the tangent: the
    // tangent has period 180 degrees, so a file saying 170 would come back as
    // -5.7 — the right line through the origin and the wrong direction along it.
    // Real files carry angles near zero, where the two agree, which is why this
    // is the kind of thing that survives every test somebody thinks to write.
    rotateDegOnScreen:
      (Math.atan2(Math.sin(rad), aspect * Math.cos(rad)) * 180) / Math.PI,
    vertices,
    worstPx,
    outOfFrameCount,
    unrecognised: alignment.unrecognised.map((u) => ({ ...u })),
  };
}

/** Every projector's alignment, in rig order. */
export function buildSosAlignments(
  truth: PreparedRig,
  compositor: PreparedRig,
  options: SosOptions = {},
): SosAlignmentExport[] {
  return compositor.projectors.map((_, i) => buildSosAlignment(truth, compositor, i, options));
}

/**
 * Read the linear part as translate / rotate / scale / shear.
 *
 * Gram-Schmidt on the columns: `M = R(theta) * [[sx, shear], [0, sy]]`. That is
 * the decomposition a "rotate, then scale each axis" reading implies, which is
 * how a `scale`/`rotate` pair in the file invites being read. A different
 * composition order gives different numbers for the same map, which is the
 * reason this is a diagnostic and not the file's content.
 */
function decomposeAffine(affX: number[], affY: number[], ratio = 1): SosAffine {
  // `ratio` conjugates the linear part into a frame whose y is compressed by
  // that factor relative to its x: `N = E M E^-1` for `E = diag(1, ratio)`.
  // 1 leaves it in the file's ±1 frame; `resY / resX` puts it on the screen.
  const m00 = 1 + affX[1];
  const m01 = affX[2] / ratio;
  const m10 = affY[1] * ratio;
  const m11 = 1 + affY[2];
  const sx = Math.hypot(m00, m10);
  const rotateDeg = sx > 0 ? (Math.atan2(m10, m00) * 180) / Math.PI : 0;
  // The second column resolved against the first, once the first is a unit.
  const ux = sx > 0 ? m00 / sx : 1;
  const uy = sx > 0 ? m10 / sx : 0;
  const shear = ux * m01 + uy * m11;
  const det = m00 * m11 - m01 * m10;
  return {
    translate: { x: affX[0], y: affY[0] },
    scale: { x: sx, y: sx > 0 ? det / sx : 0 },
    rotateDeg,
    shear,
  };
}

/**
 * Displayed width over displayed height — `warp.ts`'s aspect, and the same
 * arithmetic, because it is the same rectangle.
 *
 * `pixelAspect` belongs in it for `warp.ts`'s reason: the number is about the
 * DISPLAYED rectangle, and a non-square pixel makes that a different shape from
 * the raster's own ratio. Writing `resY * pixelAspect / resX` for the reciprocal
 * is the mistake this exists to prevent — it is right at `pixelAspect = 1`, which
 * is every rig in this repository, and wrong by the square of it everywhere else.
 */
function displayAspect(it: { resX: number; resY: number; pixelAspect: number }): number {
  return (it.resX * (it.pixelAspect || 1)) / it.resY;
}

/** The nine control points, fitted against both triangle splits at once. */
interface MeshFit {
  meshX: number[];
  meshY: number[];
  /** Per-vertex sum of squared weights, over both splits. */
  support: number[];
  peak: number;
}

/**
 * Least squares over BOTH splits' rows stacked, with the right-hand side
 * repeated — see {@link basisRow} for why this hedge beats picking a diagonal.
 */
function fitMesh(
  X: number[],
  Y: number[],
  rx: number[],
  ry: number[],
  gridSide: number,
): MeshFit {
  const n = gridSide * gridSide;
  const rows: number[][] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (const split of SPLITS) {
    for (let i = 0; i < X.length; i++) {
      rows.push(basisRow(X[i], Y[i], gridSide, split));
      bx.push(rx[i]);
      by.push(ry[i]);
    }
  }
  const support = new Array<number>(n).fill(0);
  for (const r of rows) for (let k = 0; k < n; k++) support[k] += r[k] * r[k];
  const peak = Math.max(...support);
  const ridge = peak > 0 ? peak * 1e-6 : 1;
  return {
    meshX: leastSquares(rows, bx, n, ridge) ?? new Array<number>(n).fill(0),
    meshY: leastSquares(rows, by, n, ridge) ?? new Array<number>(n).fill(0),
    support,
    peak,
  };
}

/**
 * What the fitted points leave, under whichever split is worse.
 *
 * The reported residual has to be an upper bound rather than an average: the
 * caller is deciding whether to load this file onto a projector, and a number
 * that is right for one of two possible renderers and optimistic for the other
 * is the wrong number to decide on.
 */
function worstResidual(
  X: number[],
  Y: number[],
  rx: number[],
  ry: number[],
  fit: MeshFit,
  gridSide: number,
  toPx: (x: number, y: number) => number,
): { rms: number; max: number } {
  let out = { rms: 0, max: 0 };
  for (const split of SPLITS) {
    const ex: number[] = [];
    const ey: number[] = [];
    for (let i = 0; i < X.length; i++) {
      const row = basisRow(X[i], Y[i], gridSide, split);
      ex.push(rx[i] - dot(row, fit.meshX));
      ey.push(ry[i] - dot(row, fit.meshY));
    }
    const m = magnitudes(ex, ey, toPx);
    // Each taken independently, so both numbers are upper bounds on their own.
    out = { rms: Math.max(out.rms, m.rms), max: Math.max(out.max, m.max) };
  }
  return out;
}

/** Where a sample falls: which cell of the grid, and where inside it. */
function cellAt(
  x: number,
  y: number,
  gridSide: number,
): { col: number; row: number; a: number; b: number } {
  const cells = gridSide - 1;
  // (0, 0) at the TOP-left, so `b` counts DOWN from the top edge — the ordering
  // the sample's own values imply. See the module note.
  const s = clamp01((x + 1) / 2) * cells;
  const t = clamp01((1 - y) / 2) * cells;
  const col = Math.min(cells - 1, Math.floor(s));
  const row = Math.min(cells - 1, Math.floor(t));
  return { col, row, a: s - col, b: t - row };
}

/**
 * How SOS interpolates across one cell — and the honest answer is that nobody
 * here knows, so there are two of these and the fit hedges between them.
 *
 * A graphics pipeline draws a quad as two triangles, and a triangle interpolates
 * barycentrically: three non-zero weights, not four. That is NOT the same
 * surface as a bilinear quad — they agree on the cell's edges and differ in its
 * interior — so a fit done on the wrong one hands SOS vertices optimised for a
 * warp it does not render. Which of the two diagonals SOS splits on is not
 * recorded anywhere this project can reach.
 *
 * **Measured, because the obvious fix is worse than the problem.** Committing to
 * one diagonal and being wrong costs far more than not committing at all. Worst
 * case over the two possible splits, rms pixels on the nominal rig at 61x61
 * samples:
 *
 * | field | fitted bilinear | fitted to one split | fitted to both |
 * | --- | --- | --- | --- |
 * | yaw +1 deg | 0.347 | 0.669 | **0.250** |
 * | lens +20 cm | 0.564 | 2.213 | **0.503** |
 * | k1 = 0.05 | 0.144 | 0.469 | **0.126** |
 * | yaw + roll + shift | 1.071 | 2.827 | **0.832** |
 *
 * So the fit stacks BOTH splits and the residual is reported as the worse of the
 * two renderings, which makes the reported number an upper bound whichever
 * diagonal SOS actually uses. On a symmetric field the two splits give the same
 * residual to every digit; the asymmetric row is where they come apart, by 11%.
 */
const SPLITS = ['main', 'anti'] as const;

/**
 * Barycentric weights for one cell under one diagonal: three non-zero, summing
 * to one, and exact at every vertex.
 *
 * `main` splits from the cell's top-left to its bottom-right, `anti` the other
 * way. `test/sos.test.ts` pins that both partition the cell — weights sum to
 * one, none negative, each vertex reproduced exactly — because a basis that is
 * subtly not a partition of unity fits something, just not this.
 */
function basisRow(
  x: number,
  y: number,
  gridSide: number,
  split: (typeof SPLITS)[number],
): number[] {
  const n = gridSide * gridSide;
  const row = new Array<number>(n).fill(0);
  const { col, row: r, a, b } = cellAt(x, y, gridSide);
  const at = (dr: number, dc: number): number => (r + dr) * gridSide + col + dc;
  if (split === 'main') {
    if (a >= b) {
      row[at(0, 0)] = 1 - a;
      row[at(0, 1)] = a - b;
      row[at(1, 1)] = b;
    } else {
      row[at(0, 0)] = 1 - b;
      row[at(1, 0)] = b - a;
      row[at(1, 1)] = a;
    }
  } else if (a + b <= 1) {
    row[at(0, 0)] = 1 - a - b;
    row[at(0, 1)] = a;
    row[at(1, 0)] = b;
  } else {
    row[at(0, 1)] = 1 - b;
    row[at(1, 0)] = 1 - a;
    row[at(1, 1)] = a + b - 1;
  }
  return row;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function magnitudes(
  ax: number[],
  ay: number[],
  toPx: (x: number, y: number) => number,
): { rms: number; max: number } {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < ax.length; i++) {
    const px = toPx(ax[i], ay[i]);
    sum += px * px;
    if (px > max) max = px;
  }
  return { rms: ax.length > 0 ? Math.sqrt(sum / ax.length) : 0, max };
}

/**
 * Ridge least squares by normal equations and a Cholesky factorisation.
 *
 * Normal equations rather than a QR: the systems here are 3x3 and 9x9 on a basis
 * whose entries are all in [0, 1] and sum to one per row, so the squaring of the
 * condition number that makes `A^T A` a bad idea in general costs nothing at this
 * size. `null` when the matrix is not positive definite, which the caller reads
 * as "this stage has no answer" rather than papering over with a pseudo-inverse.
 */
function leastSquares(rows: number[][], rhs: number[], n: number, ridge: number): number[] | null {
  const ata: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb = new Array<number>(n).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let a = 0; a < n; a++) {
      if (r[a] === 0) continue;
      atb[a] += r[a] * rhs[i];
      for (let b = 0; b <= a; b++) ata[a][b] += r[a] * r[b];
    }
  }
  for (let a = 0; a < n; a++) {
    ata[a][a] += ridge;
    for (let b = 0; b < a; b++) ata[b][a] = ata[a][b];
  }

  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = ata[i][j];
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        l[i][i] = Math.sqrt(s);
      } else {
        l[i][j] = s / l[j][j];
      }
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = atb[i];
    for (let k = 0; k < i; k++) s -= l[i][k] * y[k];
    y[i] = s / l[i][i];
  }
  const out = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= l[k][i] * out[k];
    out[i] = s / l[i][i];
  }
  return out;
}

/**
 * No translation, no rotation, unit scale — the two stages that found nothing.
 *
 * A function rather than a shared constant: two fields of every export point at
 * it, and one object behind both would let a caller's edit to one show up in the
 * other.
 */
function identityAffine(): SosAffine {
  return { translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotateDeg: 0, shear: 0 };
}

/** The untweaked grid, for a projector with nothing to measure. */
function identityExport(
  projectorId: string,
  gridSide: number,
  attempted: number,
): SosAlignmentExport {
  const n = gridSide * gridSide;
  return {
    projectorId,
    alignment: {
      translate: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotateDeg: 0,
      vertices: Array.from({ length: n }, (_, k) => ({
        index: k + 1,
        ...sosIdentityVertex(k, gridSide),
      })),
      gridSide,
      unrecognised: [],
    },
    equivalentAffine: identityAffine(),
    screenAffine: identityAffine(),
    residual: {
      samples: 0,
      attempted,
      fieldRmsPx: 0,
      fieldMaxPx: 0,
      affineRmsPx: 0,
      affineMaxPx: 0,
      meshRmsPx: 0,
      meshMaxPx: 0,
    },
    vertexSupport: new Array<number>(n).fill(0),
    outOfFrame: [],
  };
}

/**
 * The mesh stage without a global trend to sit on.
 *
 * Reached only when the affine's own 3x3 is singular — a projector whose samples
 * are collinear. The corners then genuinely have nothing behind them, and the
 * ridge holds them at the identity, which {@link SosAlignmentExport.vertexSupport}
 * reports as zero support so a reader can see it.
 */
function fitMeshOnly(
  projectorId: string,
  gridSide: number,
  attempted: number,
  X: number[],
  Y: number[],
  dx: number[],
  dy: number[],
  toPx: (x: number, y: number) => number,
  field: { rms: number; max: number },
): SosAlignmentExport {
  const n = gridSide * gridSide;
  const fit = fitMesh(X, Y, dx, dy, gridSide);
  const { meshX: mx, meshY: my, support, peak } = fit;
  const afterMesh = worstResidual(X, Y, dx, dy, fit, gridSide, toPx);

  const vertices: SosVertex[] = [];
  const outOfFrame: number[] = [];
  for (let k = 0; k < n; k++) {
    const id = sosIdentityVertex(k, gridSide);
    const x = id.x + mx[k];
    const y = id.y + my[k];
    vertices.push({ index: k + 1, x, y });
    if (Math.abs(x) > 1 || Math.abs(y) > 1) outOfFrame.push(k + 1);
  }
  return {
    projectorId,
    alignment: {
      translate: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotateDeg: 0,
      vertices,
      gridSide,
      unrecognised: [],
    },
    equivalentAffine: identityAffine(),
    screenAffine: identityAffine(),
    residual: {
      samples: X.length,
      attempted,
      fieldRmsPx: field.rms,
      fieldMaxPx: field.max,
      affineRmsPx: field.rms,
      affineMaxPx: field.max,
      meshRmsPx: afterMesh.rms,
      meshMaxPx: afterMesh.max,
    },
    vertexSupport: peak > 0 ? support.map((s) => s / peak) : support,
    outOfFrame,
  };
}
