// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The warp-and-blend file a player can actually load — the projection-mapping
 * deliverable.
 *
 * `docs/ARBITRARY-SHAPES.md` Q2. Everything else in this repository answers
 * "how wrong is this rig"; this answers "here is the correction". They are
 * different computations from the same trace and it is worth being explicit
 * about which is which:
 *
 *   - `packages/web/src/model.ts`'s `warpMeshes` measures the DISAGREEMENT
 *     between two calibrations — follow a pixel out through what the compositor
 *     believes, ask the real rig which pixel would have to be lit instead, and
 *     the difference is how wrong the config file is. Two rigs in, a
 *     displacement out.
 *   - This takes ONE rig — the true one, or a recovered one — and writes, for
 *     every node of a projector's raster, which texel belongs there and how
 *     brightly. One rig in, a correction out.
 *
 * ## The format, and why this one
 *
 * Paul Bourke's warp-mesh text format, which dome and planetarium players read
 * directly (Warpalizer, VIOSO, mpv's dome support, Bourke's own tools). Plain
 * text, no container, no dependency — and, decisively, its fifth field is an
 * intensity multiplier, so **warp and blend leave in one file**. A format that
 * carried only geometry would need the blend shipped beside it in something
 * else, and the two would drift.
 *
 *     2
 *     <cols> <rows>
 *     <x> <y> <u> <v> <i>
 *     ...
 *
 * `2` is the rectangular-mesh type. Nodes run row by row. `x` and `y` are
 * normalized display coordinates in [-1, 1] with **y up**; `u` and `v` are
 * texture coordinates in [0, 1] with **v up**; `i` is the multiplier, and a
 * negative value means "no data here" — the node's ray misses the object
 * entirely and the player should draw nothing.
 *
 * MPCDI is the heavier industry standard and would be the right second target:
 * a ZIP of XML plus PFM warp maps plus PNG blend maps. It carries more (multiple
 * displays, regions, a full frustum description) and needs a ZIP writer and a
 * PFM writer to say what this says in twelve lines.
 *
 * ## Two conventions that are invisible when wrong
 *
 * Both axes flip between this repository's conventions and the format's, and
 * neither mistake announces itself — each produces a picture that is plainly a
 * picture, just upside down or mirrored, which reads as "the model was exported
 * wrong" rather than as a bug here.
 *
 *   - **Raster v runs DOWN** (conventions.ts §I) and display y runs UP.
 *   - **Equirectangular v runs DOWN** from the north pole (`sampleEquirect`
 *     reads `v = (90 − lat)/180`) and texture v runs UP.
 *
 * `test/warp.test.ts` pins both against a hand-computed node rather than against
 * this paragraph.
 */

import type { ChannelTriplet } from '../../calibration/src/index.ts';
import type { PreparedRig } from './optics.ts';
import { pixelToRay } from './optics.ts';
import { coverageAndWeights, polarMask } from './coverage.ts';
import { blendModelApplies } from './surface.ts';
import { coordToUv } from './mesh/surface.ts';
import { worldLonToTextureLon } from './geometry.ts';
import type { MaskInterpretation } from './coverage.ts';

/** One node of the exported mesh. */
export interface WarpNode {
  /** Display position, [-1, 1], y up. */
  x: number;
  y: number;
  /** Texture coordinate, [0, 1], v up. `NaN` when the node reaches nothing. */
  u: number;
  v: number;
  /** Blend multiplier in [0, 1], or `-1` for a node that reaches nothing. */
  intensity: number;
}

export interface WarpExport {
  projectorId: string;
  cols: number;
  rows: number;
  /** Row-major, `cols * rows` of them. */
  nodes: WarpNode[];
  /** How many nodes reached the object. */
  onSurface: number;
  /** Sum of the intensities of the nodes that reached it, for a sanity read. */
  meanIntensity: number;
}

export interface WarpOptions {
  /** Nodes across and down. Bourke meshes are typically tens, not hundreds. */
  cols?: number;
  rows?: number;
  /** How `set bottommask` is read, for the sphere's polar mask. */
  maskInterpretation?: MaskInterpretation;
}

/**
 * Build the warp-and-blend mesh for one projector.
 *
 * For each node: send the pixel out through the rig, find where it lands on the
 * object, ask what content belongs at that point and what this projector's share
 * of it is. A node whose ray misses gets `intensity = -1`, which is the
 * format's own way of saying "draw nothing" — and it matters that this is
 * explicit rather than a zero, because a zero is a black pixel the projector
 * still emits its black floor into, and the difference is the rectangle of glow
 * around every real installation.
 */
export function buildWarpExport(
  rig: PreparedRig,
  index: number,
  options: WarpOptions = {},
): WarpExport {
  const projector = rig.projectors[index];
  if (!projector) throw new Error(`no projector at index ${index}`);
  const cols = Math.max(2, Math.floor(options.cols ?? 41));
  const rows = Math.max(2, Math.floor(options.rows ?? 41));
  const it = projector.cal.intrinsics;
  const masked = blendModelApplies(rig.surface);
  const interpretation = options.maskInterpretation ?? 'latitude';

  const nodes: WarpNode[] = new Array<WarpNode>(cols * rows);
  let onSurface = 0;
  let intensitySum = 0;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // Node positions span the raster corner to corner, so the mesh describes
      // the whole frame rather than the centres of a grid inside it.
      const u = (i / (cols - 1)) * it.resX;
      const v = (j / (rows - 1)) * it.resY;
      // Display coordinates: x right, y UP. Raster v runs down.
      const x = (u / it.resX) * 2 - 1;
      const y = 1 - (v / it.resY) * 2;

      const hit = rig.surface.intersect(projector.lens, pixelToRay(projector, u, v));
      if (hit === null) {
        nodes[j * cols + i] = { x, y, u: Number.NaN, v: Number.NaN, intensity: -1 };
        continue;
      }

      const coord = rig.surface.coordAt(hit.point);
      // The sphere's texture is anchored to the world by a mechanical rotation;
      // a mesh's UV is anchored by its own unwrap and has no such offset.
      const texLon = masked
        ? worldLonToTextureLon(coord.lonDeg, rig.rotationOffsetDeg)
        : coord.lonDeg;
      const tex = coordToUv({ latDeg: coord.latDeg, lonDeg: texLon });

      const { weights } = coverageAndWeights(hit.point, hit.normal, rig);
      const mask = masked ? polarMask(coord.latDeg, rig.blend, interpretation) : 1;
      const intensity = weights[index] * mask;

      nodes[j * cols + i] = {
        x,
        y,
        u: tex.u,
        // Equirectangular v runs DOWN from the north pole; texture v runs up.
        v: 1 - tex.v,
        intensity,
      };
      onSurface++;
      intensitySum += intensity;
    }
  }

  return {
    projectorId: projector.cal.id,
    cols,
    rows,
    nodes,
    onSurface,
    meanIntensity: onSurface > 0 ? intensitySum / onSurface : 0,
  };
}

/**
 * Serialize to Bourke's text format.
 *
 * Six significant figures. A node position is a fraction of a frame, so six
 * figures resolves about a hundredth of a pixel on a 4K projector — well past
 * anything the warp can act on — while writing the full seventeen would triple
 * the file for digits that are noise from a float64 trace.
 */
export function formatWarpMesh(exported: WarpExport): string {
  const out: string[] = ['2', `${exported.cols} ${exported.rows}`];
  for (const n of exported.nodes) {
    if (!(n.intensity >= 0) || !Number.isFinite(n.u) || !Number.isFinite(n.v)) {
      // A node with no data still has to occupy its place in the grid: the
      // format is positional, and skipping a line shifts every node after it.
      out.push(`${f(n.x)} ${f(n.y)} 0 0 -1`);
      continue;
    }
    out.push(`${f(n.x)} ${f(n.y)} ${f(n.u)} ${f(n.v)} ${f(n.intensity)}`);
  }
  return `${out.join('\n')}\n`;
}

function f(value: number): string {
  // `toPrecision` gives exponent form for small numbers, which the format's
  // readers do not all accept. Fixed with six decimals covers [-1, 1] to the
  // same resolution without ever producing an `e`.
  const s = value.toFixed(6);
  // Negative zero is a valid float and an eyesore in a text file people diff.
  return s === '-0.000000' ? '0.000000' : s;
}

/** Every projector's mesh, in rig order. */
export function buildWarpExports(rig: PreparedRig, options: WarpOptions = {}): WarpExport[] {
  return rig.projectors.map((_, i) => buildWarpExport(rig, i, options));
}

/**
 * The colour a warp node should be tinted, for a caller drawing the mesh.
 *
 * Not part of the format. Here because a caller that wants to SHOW a warp mesh
 * wants the same intensity the file carries, and recomputing it from the nodes
 * would be a second definition of the same number.
 */
export function warpNodeTint(node: WarpNode, base: ChannelTriplet): ChannelTriplet {
  const k = node.intensity > 0 ? node.intensity : 0;
  return { r: base.r * k, g: base.g * k, b: base.b * k };
}
