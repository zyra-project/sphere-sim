// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The footprint field's layout, at both strides.
 *
 * `pack.ts` writes one texel per triangle corner up to four projectors and two
 * up to eight. The two facts worth pinning are opposite in kind:
 *
 *   1. **Stride 1 is the old layout, byte for byte.** Widening a format that
 *      every existing mesh render reads is only safe if the narrow case does
 *      not move, and "corner-major so `c * stride + k` degenerates to `0, 1, 2`"
 *      is an argument. The digests below were captured from the packer BEFORE
 *      the stride existed, so this is a measurement of that argument.
 *   2. **Stride 2 puts each projector where the shader looks for it.** Round
 *      trips through `readPackedField`, which sits beside the writer precisely
 *      so a disagreement about byte order fails here rather than as a dim
 *      projector in a picture nobody is measuring.
 */

import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { test } from 'node:test';

import { buildBvh } from '../src/mesh/bvh.ts';
import {
  FIELD_CHANNELS,
  FIELD_CORNERS,
  FIELD_PROJECTORS,
  fieldStrideFor,
  fieldTexelsFor,
  packBvh,
  readPackedField,
} from '../src/mesh/pack.ts';
import type { SurfaceMesh } from '../../calibration/src/index.ts';
import type { FootprintField } from '../src/footprint.ts';

/** A tessellated ellipsoid, big enough that the field spans several texel rows. */
function body(nLon: number, nLat: number): SurfaceMesh {
  const p: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nLat; j++) {
    const v = j / nLat;
    const th = v * Math.PI;
    for (let i = 0; i <= nLon; i++) {
      const u = i / nLon;
      const ph = u * 2 * Math.PI;
      p.push(
        Math.sin(th) * Math.cos(ph),
        0.8 * Math.sin(th) * Math.sin(ph),
        0.6 * Math.cos(th) + 1.5,
      );
      uv.push(u, v);
    }
  }
  for (let j = 0; j < nLat; j++) {
    for (let i = 0; i < nLon; i++) {
      const a = j * (nLon + 1) + i;
      const b = a + nLon + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    schema: 'sphere-sim/surface-mesh@1',
    name: 'test-ellipsoid',
    positions: new Float64Array(p),
    normals: null,
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    vertexCount: p.length / 3,
    triangleCount: idx.length / 3,
  } satisfies SurfaceMesh;
}

/**
 * A field whose value is a known function of vertex and projector.
 *
 * Distinct per (vertex, projector) so a reader that swapped two channels, two
 * corners or two texels reads a number belonging to something else rather than
 * a plausible one. A constant per projector would pass a transposed layout.
 */
function marked(mesh: SurfaceMesh, j: number): FootprintField {
  const d = new Float64Array(mesh.vertexCount);
  for (let v = 0; v < mesh.vertexCount; v++) d[v] = 1000 * (j + 1) + v;
  return { distance: d, litVertices: mesh.vertexCount } as FootprintField;
}

const MESH = body(24, 12);
const BVH = buildBvh(MESH);

test('a rig of four or fewer packs the bytes it always did', () => {
  // The pre-widening writer, transcribed from the commit before the stride
  // existed. Not a digest: a hash says "something moved" and this says WHERE,
  // and it stays readable when the fixture changes. The empirical form of the
  // same check was run once against the real packer at 1, 2, 3 and 4 projectors
  // over `prepareRig`'s own footprints and matched to the byte; this is what
  // keeps it true.
  //
  //     const base = 4 * 3 * t;        // three texels per triangle
  //     const at = base + 4 * c;       // one per corner, consecutive
  //     out[at + j] = d[v];            // projector j in channel j
  for (const n of [1, 2, 3, 4]) {
    const fields = Array.from({ length: n }, (_, k) => marked(MESH, k));
    const packed = packBvh(BVH, MESH, fields);
    assert.equal(packed.fieldStride, 1, `${n} projectors should need one texel per corner`);
    const f = packed.field;
    assert.ok(f !== null);

    for (let t = 0; t < MESH.triangleCount; t++) {
      const tri = BVH.order[t];
      const base = 4 * 3 * t;
      for (let c = 0; c < 3; c++) {
        const v = MESH.indices[3 * tri + c];
        const at = base + 4 * c;
        for (let j = 0; j < 4; j++) {
          const want = j < n ? 1000 * (j + 1) + v : 0;
          assert.equal(f[at + j], want, `${n} projectors: triangle ${t} corner ${c} channel ${j}`);
        }
      }
    }

    // And nothing was written past the triangles: a stride that leaked would
    // show up as a longer buffer even when every value above checked out.
    assert.equal(f.length, 4 * packed.fieldWidth * packed.fieldHeight);
    assert.ok(3 * MESH.triangleCount <= packed.fieldWidth * packed.fieldHeight);
  }
});

test('every projector round-trips to the corner it belongs to, at both strides', () => {
  for (const n of [1, 4, 5, 8]) {
    const fields = Array.from({ length: n }, (_, j) => marked(MESH, j));
    const packed = packBvh(BVH, MESH, fields);
    assert.equal(packed.fieldStride, fieldStrideFor(n));

    // Every triangle, every corner, every projector — the whole buffer, because
    // an off-by-one in the stride shows up at a triangle boundary and checking
    // triangle 0 alone would miss it.
    for (let t = 0; t < MESH.triangleCount; t++) {
      const tri = BVH.order[t];
      const got = readPackedField(packed, t, 0);
      assert.ok(got !== null);
      assert.equal(got.length, FIELD_CHANNELS * packed.fieldStride);
      for (let c = 0; c < FIELD_CORNERS; c++) {
        const v = MESH.indices[3 * tri + c];
        const vals = readPackedField(packed, t, c);
        assert.ok(vals !== null);
        for (let j = 0; j < n; j++) {
          assert.equal(vals[j], 1000 * (j + 1) + v, `triangle ${t} corner ${c} projector ${j}`);
        }
        // Channels past the rig are zero, which the shader reads as "not inside
        // this projector's footprint" and takes its hard-seam fallback from.
        for (let j = n; j < vals.length; j++) {
          assert.equal(vals[j], 0, `triangle ${t} corner ${c} slot ${j} is not empty`);
        }
      }
    }
  }
});

test('the buffer grows only for a rig that needs it', () => {
  const four = packBvh(BVH, MESH, Array.from({ length: 4 }, (_, j) => marked(MESH, j)));
  const five = packBvh(BVH, MESH, Array.from({ length: 5 }, (_, j) => marked(MESH, j)));
  assert.ok(four.field !== null && five.field !== null);
  // Exactly double, not "about" double: the stride is the only thing that moved.
  assert.equal(five.field.length, 2 * four.field.length);
  assert.equal(fieldTexelsFor(1), FIELD_CORNERS);
  assert.equal(fieldTexelsFor(2), 2 * FIELD_CORNERS);
});

test('a rig too wide for the layout is refused rather than folded into a channel', () => {
  const fields = Array.from({ length: FIELD_PROJECTORS + 1 }, (_, j) => marked(MESH, j));
  assert.throws(() => packBvh(BVH, MESH, fields), /nowhere to go/);
  // The cap and the page shader's MAX_PROJ have to move together: contentWeight
  // indexes its field by projector, so a rig the uniforms accept and the field
  // cannot carry would read past the end of a vector.
  assert.equal(FIELD_PROJECTORS, 8);
});
