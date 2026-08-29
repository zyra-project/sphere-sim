// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The GLB reader, against files assembled byte by byte from the spec.
 *
 * Not against a fixture exported by a modelling tool. A fixture proves the
 * reader agrees with whatever that one exporter happened to write, and the cases
 * that break a loader are the ones a single exporter never produces: interleaved
 * buffer views, normalized integer attributes, a mesh parked under a scaled
 * parent, a scene that reaches the same node twice. So the builders below emit
 * the container the specification describes, and each test bends one thing.
 *
 * The load-bearing check is `readGlb` -> `MeshSurface` -> compared against
 * `raySphereIntersect`: a tessellated sphere written out as a GLB and read back
 * has to intersect where the analytic sphere does. That closes the loop from
 * bytes to geometry, through both the reader and the simulator's own tracer.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { readGlb } from '../src/glb.ts';
import type { SurfaceMesh } from '../../calibration/src/index.ts';
import { meshSurface } from '../../sim/src/mesh/surface.ts';
import { latLonToWorld, raySphereIntersect } from '../../sim/src/geometry.ts';

const R = 0.8636;

// ---------------------------------------------------------------------------
// Builders: a conforming GLB, assembled from the spec
// ---------------------------------------------------------------------------

interface BuildOptions {
  /** Vertex positions, flat, in the FILE's frame (Y-up unless a test says otherwise). */
  positions: number[];
  indices?: number[];
  normals?: number[];
  uvs?: number[];
  /** Extra JSON merged over the generated document, for bending one thing. */
  patch?: (doc: Record<string, unknown>) => void;
  mode?: number;
}

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

/** A GLB with one mesh, one primitive, float32 attributes and uint32 indices. */
function buildGlb(o: BuildOptions): Uint8Array {
  const chunks: { data: Uint8Array; kind: string }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const parts: Uint8Array[] = [];
  let binLength = 0;

  const addView = (bytes: Uint8Array): number => {
    // Views are aligned to four, which the spec requires for the component sizes
    // used here and which a reader that ignored `byteOffset` would survive.
    const padding = pad4(binLength);
    if (padding > 0) {
      parts.push(new Uint8Array(padding));
      binLength += padding;
    }
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
    parts.push(bytes);
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const f32 = (values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
  const u32 = (values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);

  const posView = addView(f32(o.positions));
  accessors.push({
    bufferView: posView,
    componentType: 5126,
    count: o.positions.length / 3,
    type: 'VEC3',
  });
  const attributes: Record<string, number> = { POSITION: 0 };

  if (o.normals !== undefined) {
    const v = addView(f32(o.normals));
    accessors.push({ bufferView: v, componentType: 5126, count: o.normals.length / 3, type: 'VEC3' });
    attributes.NORMAL = accessors.length - 1;
  }
  if (o.uvs !== undefined) {
    const v = addView(f32(o.uvs));
    accessors.push({ bufferView: v, componentType: 5126, count: o.uvs.length / 2, type: 'VEC2' });
    attributes.TEXCOORD_0 = accessors.length - 1;
  }
  const primitive: Record<string, unknown> = { attributes, mode: o.mode ?? 4 };
  if (o.indices !== undefined) {
    const v = addView(u32(o.indices));
    accessors.push({ bufferView: v, componentType: 5125, count: o.indices.length, type: 'SCALAR' });
    primitive.indices = accessors.length - 1;
  }

  const doc: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0], name: 'test-scene' }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive], name: 'test-mesh' }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  o.patch?.(doc);

  const bin = new Uint8Array(binLength);
  let at = 0;
  for (const p of parts) {
    bin.set(p, at);
    at += p.byteLength;
  }
  chunks.push({ data: new TextEncoder().encode(JSON.stringify(doc)), kind: 'JSON' });
  chunks.push({ data: bin, kind: 'BIN' });
  return assembleGlb(chunks);
}

function assembleGlb(chunks: { data: Uint8Array; kind: string }[]): Uint8Array {
  let total = 12;
  for (const c of chunks) total += 8 + c.data.byteLength + pad4(c.data.byteLength);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let at = 12;
  for (const c of chunks) {
    const padding = pad4(c.data.byteLength);
    dv.setUint32(at, c.data.byteLength + padding, true);
    dv.setUint32(at + 4, c.kind === 'JSON' ? 0x4e4f534a : 0x004e4942, true);
    out.set(c.data, at + 8);
    // JSON pads with spaces and BIN with zeros, per the spec.
    if (padding > 0 && c.kind === 'JSON') out.fill(0x20, at + 8 + c.data.byteLength, at + 8 + c.data.byteLength + padding);
    at += 8 + c.data.byteLength + padding;
  }
  return out;
}

/** A lat/lon tessellation, in the FILE's Y-up frame. */
function uvSphereGlb(segments: number, rings: number): Uint8Array {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let iy = 0; iy <= rings; iy++) {
    const latDeg = 90 - (iy / rings) * 180;
    for (let ix = 0; ix <= segments; ix++) {
      const lonDeg = -180 + (ix / segments) * 360;
      const p = latLonToWorld(latDeg, lonDeg, R);
      // World Z-up -> file Y-up is the inverse of what the reader will apply:
      // (x, y, z)_world comes from (x, z, -y)_file.
      positions.push(p.x, p.z, -p.y);
      uvs.push(ix / segments, iy / rings);
    }
  }
  const indices: number[] = [];
  const at = (ix: number, iy: number): number => iy * (segments + 1) + ix;
  for (let iy = 0; iy < rings; iy++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = at(ix, iy);
      const b = at(ix + 1, iy);
      const c = at(ix + 1, iy + 1);
      const d = at(ix, iy + 1);
      if (iy !== 0) indices.push(a, d, b);
      if (iy !== rings - 1) indices.push(b, d, c);
    }
  }
  return buildGlb({ positions, indices, uvs });
}

// ---------------------------------------------------------------------------

test('a GLB round-trips to a mesh that intersects where the analytic sphere does', () => {
  const report = readGlb(uvSphereGlb(128, 64));
  assert.ok(report.mesh !== null, `expected a mesh, got: ${report.skipped.join('; ')}`);
  assert.equal(report.format, 'glb');
  assert.equal(report.hasUvs, true);

  const surface = meshSurface(report.mesh);
  let compared = 0;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const origin = { x: 5.18 * Math.cos(a), y: 5.18 * Math.sin(a), z: 0.4 * Math.sin(2 * a) };
    const len = Math.hypot(origin.x, origin.y, origin.z);
    const dir = { x: -origin.x / len, y: -origin.y / len, z: -origin.z / len };
    const truth = raySphereIntersect(origin, dir, R);
    const got = surface.intersect(origin, dir);
    assert.ok(truth !== null && got !== null, 'both must hit a sphere aimed at from outside');
    // Chord sag at 128x64, the same bound `mesh-surface.test.ts` derives.
    assert.ok(
      Math.abs(got.t - truth.t) < 1e-3,
      `file-loaded mesh hit at ${got.t}, analytic at ${truth.t}`,
    );
    compared++;
  }
  assert.equal(compared, 32);
});

test('the up axis is converted: a file that is Y-up lands Z-up', () => {
  // One triangle standing on the file's +Y. After the quarter turn it must
  // stand on world +Z, or every model loads on its side.
  const glb = buildGlb({ positions: [0, 1, 0, 1, 0, 0, -1, 0, 0], indices: [0, 1, 2] });
  const report = readGlb(glb);
  assert.ok(report.mesh !== null);
  const p = report.mesh.positions;
  assert.ok(Math.abs(p[0] - 0) < 1e-12 && Math.abs(p[1] - 0) < 1e-12 && Math.abs(p[2] - 1) < 1e-12,
    `file +Y must become world +Z, got (${p[0]}, ${p[1]}, ${p[2]})`);

  // And the escape hatch leaves it alone.
  const asIs = readGlb(glb, { upAxis: 'z' });
  assert.ok(asIs.mesh !== null);
  assert.ok(Math.abs(asIs.mesh.positions[1] - 1) < 1e-12, 'upAxis "z" must not rotate');
});

test('the up-axis rotation preserves winding, so normals still point outward', () => {
  // A rotation cannot mirror. If the conversion ever became a mirroring one, a
  // closed model would turn inside out and every surface would face away from
  // its projector — visible as a sphere that is lit from within.
  const glb = buildGlb({
    positions: [0, 0, 0, 1, 0, 0, 0, 0, -1],
    indices: [0, 1, 2],
  });
  const report = readGlb(glb);
  assert.ok(report.mesh !== null);
  const surface = meshSurface(report.mesh);
  // The triangle lies in the world XY plane; its outward normal is +Z.
  const hit = surface.intersect({ x: 0.25, y: 0.25, z: 1 }, { x: 0, y: 0, z: -1 });
  assert.ok(hit !== null);
  assert.ok(hit.normal.z > 0.99, `expected an outward +Z normal, got ${hit.normal.z}`);
});

test('a node transform is applied, and a nested one accumulates', () => {
  const glb = buildGlb({
    positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
    indices: [0, 1, 2],
    patch: (doc) => {
      // A scaled parent holding a translated child holding the mesh. Reading
      // meshes[] and ignoring nodes[] gives a model that loads and sits in the
      // wrong place at the wrong size.
      doc.scenes = [{ nodes: [0] }];
      doc.nodes = [
        { children: [1], scale: [2, 2, 2] },
        { children: [2], translation: [10, 0, 0] },
        { mesh: 0 },
      ];
    },
  });
  const report = readGlb(glb);
  assert.ok(report.mesh !== null);
  // Vertex 0 is the file origin: translated by 10 then scaled by 2 gives x = 20.
  assert.ok(Math.abs(report.mesh.positions[0] - 20) < 1e-9, `x = ${report.mesh.positions[0]}`);
});

test('a non-uniform scale carries normals through the inverse transpose', () => {
  // A 45-degree face under a 4x squash in one axis. Transforming the normal by
  // the position matrix leaves it off the surface, and every incidence cosine
  // downstream is then wrong on exactly the models set-builders make.
  const s = Math.SQRT1_2;
  const glb = buildGlb({
    positions: [0, 0, 0, 1, 1, 0, 0, 0, 1],
    normals: [s, -s, 0, s, -s, 0, s, -s, 0],
    indices: [0, 1, 2],
    patch: (doc) => {
      doc.nodes = [{ mesh: 0, scale: [4, 1, 1] }];
    },
  });
  const report = readGlb(glb);
  assert.ok(report.mesh !== null && report.mesh.normals !== null);
  const n = report.mesh.normals;
  // Under x scaled by 4, the normal's x component shrinks by 4 relative to y —
  // the inverse transpose, not the transform. In world axes (file y -> world z),
  // that is |nx| / |nz| = (s/4) / s = 0.25.
  const ratio = Math.abs(n[0]) / Math.abs(n[2]);
  assert.ok(Math.abs(ratio - 0.25) < 1e-6, `expected the inverse-transpose ratio 0.25, got ${ratio}`);
  // And it stays a unit vector.
  assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-9);
});

test('interleaved buffer views are read through their stride', () => {
  // Position and UV packed into one view, five floats per vertex. An exporter
  // that interleaves is common and a reader that ignores byteStride reads
  // garbage that still looks like a mesh.
  const verts = [
    // x, y, z, u, v
    0, 0, 0, 0, 0,
    1, 0, 0, 1, 0,
    0, 1, 0, 0, 1,
  ];
  const bytes = new Uint8Array(Float32Array.from(verts).buffer);
  const glb = assembleGlb([
    {
      kind: 'JSON',
      data: new TextEncoder().encode(
        JSON.stringify({
          asset: { version: '2.0' },
          scene: 0,
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, mode: 4 }] }],
          accessors: [
            { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
            { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC2' },
          ],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength, byteStride: 20 }],
          buffers: [{ byteLength: bytes.byteLength }],
        }),
      ),
    },
    { kind: 'BIN', data: bytes },
  ]);
  const report = readGlb(glb);
  assert.ok(report.mesh !== null, report.skipped.join('; '));
  assert.equal(report.hasUvs, true);
  assert.ok(report.mesh.uvs !== null);
  // Vertex 1's UV is (1, 0); a stride-blind reader would have read a position.
  assert.ok(Math.abs(report.mesh.uvs[2] - 1) < 1e-6, `u1 = ${report.mesh.uvs?.[2]}`);
  assert.ok(Math.abs(report.mesh.uvs[3] - 0) < 1e-6);
  // Un-indexed geometry is legal: three vertices are one triangle.
  assert.equal(report.mesh.triangleCount, 1);
});

test('normalized integer attributes are scaled, not read raw', () => {
  const uvBytes = new Uint8Array([0, 0, 255, 0, 0, 255]);
  const posBytes = new Uint8Array(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const bin = new Uint8Array(posBytes.byteLength + uvBytes.byteLength);
  bin.set(posBytes, 0);
  bin.set(uvBytes, posBytes.byteLength);
  const glb = assembleGlb([
    {
      kind: 'JSON',
      data: new TextEncoder().encode(
        JSON.stringify({
          asset: { version: '2.0' },
          scene: 0,
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, mode: 4 }] }],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
            { bufferView: 1, componentType: 5121, count: 3, type: 'VEC2', normalized: true },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
            { buffer: 0, byteOffset: posBytes.byteLength, byteLength: uvBytes.byteLength },
          ],
          buffers: [{ byteLength: bin.byteLength }],
        }),
      ),
    },
    { kind: 'BIN', data: bin },
  ]);
  const report = readGlb(glb);
  assert.ok(report.mesh !== null && report.mesh.uvs !== null, report.skipped.join('; '));
  // 255 must read as 1.0, not as 255 — a UV in the hundreds wraps a texture
  // hundreds of times and looks like a broken unwrap rather than a broken reader.
  assert.ok(Math.abs(report.mesh.uvs[2] - 1) < 1e-6, `u = ${report.mesh.uvs?.[2]}`);
});

test('several primitives and several nodes merge into one surface', () => {
  const glb = buildGlb({
    positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
    indices: [0, 1, 2],
    patch: (doc) => {
      // The same mesh instanced under two nodes — legal glTF, and the index
      // offsetting is where a merge goes wrong.
      doc.scenes = [{ nodes: [0, 1] }];
      doc.nodes = [{ mesh: 0 }, { mesh: 0, translation: [5, 0, 0] }];
    },
  });
  const report = readGlb(glb);
  assert.ok(report.mesh !== null);
  assert.equal(report.mesh.triangleCount, 2);
  assert.equal(report.mesh.vertexCount, 6);
  // The second instance's indices must point at the second instance's vertices.
  const idx = report.mesh.indices;
  assert.deepEqual(Array.from(idx), [0, 1, 2, 3, 4, 5]);
  assert.ok(Math.abs(report.mesh.positions[9] - 5) < 1e-9, 'the instance must be translated');
});

// ---------------------------------------------------------------------------
// What it refuses, and how loudly
// ---------------------------------------------------------------------------

test('a non-triangle primitive is named in the report rather than dropped in silence', () => {
  const report = readGlb(buildGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], mode: 1 }));
  assert.equal(report.mesh, null);
  assert.ok(
    report.skipped.some((s) => s.includes('LINES')),
    `expected LINES to be named, got: ${report.skipped.join('; ')}`,
  );
});

test('Draco compression is named, because the fix is to re-export', () => {
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        const meshes = doc.meshes as { primitives: Record<string, unknown>[] }[];
        meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0 } };
      },
    }),
  );
  assert.equal(report.mesh, null);
  assert.ok(report.skipped.some((s) => s.includes('Draco')));
});

test('an external buffer is refused rather than silently fetched', () => {
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        (doc.buffers as Record<string, unknown>[])[0].uri = 'model.bin';
      },
    }),
  );
  assert.equal(report.mesh, null);
  assert.ok(report.skipped.some((s) => s.includes('external buffer')));
});

test('a file that is not a GLB throws, because that is the caller being wrong', () => {
  assert.throws(() => readGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /not a GLB/);
  assert.throws(() => readGlb(new Uint8Array(4)), /fewer than 12 bytes/);
});

test('an unsupported glTF version is a report, not a throw', () => {
  const glb = buildGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] });
  new DataView(glb.buffer, glb.byteOffset).setUint32(4, 1, true);
  const report = readGlb(glb);
  assert.equal(report.mesh, null);
  assert.ok(report.skipped.some((s) => s.includes('version 1')));
});

test('a mesh with no UV set loads, it just has no content', () => {
  const report = readGlb(buildGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }));
  assert.ok(report.mesh !== null);
  assert.equal(report.hasUvs, false);
  assert.equal(report.mesh.uvs, null);
  // Coverage, overlap and blend are all answerable without a texture, and those
  // are most of what a projection-mapping preview is for.
  assert.ok(meshSurface(report.mesh).areaM2 > 0);
});

test('a document of the wrong SHAPE is a report, never an exception', () => {
  // The type declaration over `JSON.parse` is an assertion, not a check. Every
  // field below is declared as a number or an array and is something else in the
  // file, and each one used to reach code that assumed the declaration: five of
  // these ten threw a TypeError out of a function whose contract is that a
  // merely-unusable file produces a report, and one built a mesh whose positions
  // were all NaN.
  //
  // Written as one table rather than ten tests because the property is one
  // property -- no shape of document escapes as an exception -- and a table is
  // where the eleventh case gets added.
  const wrong: [string, (doc: Record<string, unknown>) => void][] = [
    ['children is a number', (d) => setNode(d, 'children', 5)],
    ['children is a string', (d) => setNode(d, 'children', 'abc')],
    ['translation is a number', (d) => setNode(d, 'translation', 4)],
    ['rotation is too short', (d) => setNode(d, 'rotation', [0, 0])],
    ['matrix is a 16-character string', (d) => setNode(d, 'matrix', 'abcdefghijklmnop')],
    ['primitives is a number', (d) => ((d.meshes as Record<string, unknown>[])[0].primitives = 7)],
    [
      'attributes is missing',
      (d) => delete (d.meshes as { primitives: Record<string, unknown>[] }[])[0].primitives[0].attributes,
    ],
    [
      'attributes is a string',
      (d) => ((d.meshes as { primitives: Record<string, unknown>[] }[])[0].primitives[0].attributes = 'x'),
    ],
    ['scene nodes is a number', (d) => ((d.scenes as Record<string, unknown>[])[0].nodes = 3)],
    ['accessors is not an array', (d) => (d.accessors = 'no')],
    [
      'a bufferView byteLength is a string',
      (d) => ((d.bufferViews as Record<string, unknown>[])[0].byteLength = 'lots'),
    ],
    // The eleventh through fourteenth cases. `for...of` over a non-array throws
    // "object is not iterable", and `null` is an object to `typeof` and legal
    // JSON, so every one of these reached a property read on it.
    ['buffers is an object', (d) => (d.buffers = {})],
    ['a buffer entry is null', (d) => (d.buffers = [null])],
    ['a mesh entry is null', (d) => (d.meshes = [null])],
    [
      'a primitive entry is null',
      (d) => ((d.meshes as Record<string, unknown>[])[0].primitives = [null]),
    ],
  ];

  for (const [name, mutate] of wrong) {
    const glb = buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: mutate,
    });
    let report;
    try {
      report = readGlb(glb);
    } catch (err) {
      assert.fail(`${name} threw instead of reporting: ${(err as Error).message}`);
    }
    // Whatever it decides, the numbers it returns have to be numbers.
    if (report.mesh !== null) {
      for (const v of report.mesh.positions) {
        assert.ok(Number.isFinite(v), `${name} produced a non-finite position`);
      }
      assert.equal(report.mesh.positions.length, 3 * report.mesh.vertexCount, name);
      assert.equal(report.mesh.indices.length, 3 * report.mesh.triangleCount, name);
      for (const i of report.mesh.indices) {
        assert.ok(i < report.mesh.vertexCount, `${name} produced an out-of-range index`);
      }
    }
  }
});

/** Set one field on the first node, whatever shape the test wants it to be. */
function setNode(doc: Record<string, unknown>, key: string, value: unknown): void {
  doc.scenes = [{ nodes: [0] }];
  const node: Record<string, unknown> = { mesh: 0 };
  node[key] = value;
  doc.nodes = [node];
}

test('a node cycle is named as a cycle, not as exhausted depth', () => {
  // This asserted the depth message before the walk could tell the two apart.
  // It is worth the sharper assertion: "deeper than 256 levels" sends whoever
  // reads it looking for a deep model, and the file in front of them has two
  // nodes.
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        doc.scenes = [{ nodes: [0] }];
        doc.nodes = [{ children: [1] }, { children: [0], mesh: 0 }];
      },
    }),
  );
  assert.ok(
    report.skipped.some((s) => s.includes('cycle')),
    `expected a cycle report, got ${JSON.stringify(report.skipped)}`,
  );
  assert.ok(!report.skipped.some((s) => s.includes('deeper than')));
  // The mesh on the far side of the cycle still loads: the walk refuses to
  // re-enter a node it is already inside, it does not abandon the file.
  assert.equal(report.mesh?.triangleCount, 1);
});

test('a subtree repeated at every level cannot expand exponentially', () => {
  // Legal, acyclic, and 24 levels deep, so no depth cap sees anything wrong --
  // but each node lists the one below it TWICE, so a walk that only counts
  // depth emits 2^24 instances from a document of a few hundred bytes. This is
  // the case the depth cap was mistaken for covering.
  const depth = 24;
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        const chain: Record<string, unknown>[] = [];
        for (let i = 0; i < depth; i++) chain.push({ children: [i + 1, i + 1] });
        chain.push({ mesh: 0 });
        doc.scenes = [{ nodes: [0] }];
        doc.nodes = chain;
      },
    }),
  );
  assert.ok(
    report.skipped.some((s) => s.includes('instances')),
    `expected an instance-count refusal, got ${JSON.stringify(report.skipped)}`,
  );
  // It stops at the ceiling rather than running to 2^24.
  assert.ok((report.mesh?.triangleCount ?? 0) <= 65536);
});

test('an accessor claiming billions of elements is refused, not allocated', () => {
  // The count is a number in JSON a stranger uploaded and it sizes an array
  // this reader creates. Unchecked, `2e9` asks for a 16 GB Float64Array, which
  // is not an exception -- it is the worker dying with no message.
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        (doc.accessors as Record<string, unknown>[])[0].count = 2_000_000_000;
      },
    }),
  );
  assert.equal(report.mesh, null);
  assert.ok(
    report.skipped.some((s) => s.includes('elements')),
    `expected a size refusal, got ${JSON.stringify(report.skipped)}`,
  );
});

test('an index outside the primitive is refused rather than read as geometry', () => {
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 99],
    }),
  );
  // `null` rather than an empty mesh, and that is the finding: the primitive's
  // positions had already been appended when the bad index was found, so before
  // the reorder this returned a mesh of three vertices and no triangles.
  assert.equal(report.mesh, null);
  assert.ok(
    report.skipped.some((s) => s.includes('index')),
    `expected an index refusal, got ${JSON.stringify(report.skipped)}`,
  );
});

test('a mirrored node transform is un-mirrored, so the model is not inside out', () => {
  // glTF permits a negative scale. It reverses winding while the index buffer
  // stays as written, so every face ends up pointing away -- the model loads,
  // the preview draws a recognizable object, and coverage reads 0%.
  //
  // A single triangle cannot show this: it has two sides and no outside. The
  // fixture is a closed tetrahedron, wound outward, and the property is that
  // every face still points away from the centroid after the mirror.
  const tet = {
    positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
    indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
  };
  const outward = (m: SurfaceMesh): number => {
    const p = m.positions;
    const i = m.indices;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      cx += p[3 * v];
      cy += p[3 * v + 1];
      cz += p[3 * v + 2];
    }
    cx /= m.vertexCount;
    cy /= m.vertexCount;
    cz /= m.vertexCount;
    let facingOut = 0;
    for (let t = 0; t < m.triangleCount; t++) {
      const a = 3 * i[3 * t];
      const b = 3 * i[3 * t + 1];
      const c = 3 * i[3 * t + 2];
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a];
      const vy = p[c + 1] - p[a + 1];
      const vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      // Does the face normal point away from the centroid?
      if (nx * (p[a] - cx) + ny * (p[a + 1] - cy) + nz * (p[a + 2] - cz) > 0) facingOut++;
    }
    return facingOut;
  };

  const plain = readGlb(buildGlb(tet));
  assert.ok(plain.mesh !== null);
  assert.equal(outward(plain.mesh), 4, 'the fixture itself must be wound outward');

  const mirrored = readGlb(
    buildGlb({
      ...tet,
      patch: (doc) => {
        doc.scenes = [{ nodes: [0] }];
        doc.nodes = [{ mesh: 0, scale: [1, 1, -1] }];
      },
    }),
  );
  assert.ok(mirrored.mesh !== null);
  assert.equal(mirrored.mesh.triangleCount, 4);
  // Without the corner swap this is 0 of 4 -- every face inward, which is the
  // exact signature of the bug: a model that loads and lights nothing.
  assert.equal(
    outward(mirrored.mesh),
    4,
    'a mirrored transform left the model inside out',
  );
});

test('one primitive without normals drops them for the whole file', () => {
  // The all-or-nothing policy, enforced rather than described. `any` shipped
  // the attribute-less primitive's fabricated (0, 0, 0) as real data — a
  // zero-length normal — and reported the whole mesh as file-shaded.
  //
  // Two primitives on one mesh: the first supplies NORMAL and TEXCOORD_0, the
  // second supplies neither.
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      patch: (doc) => {
        const accessors = doc.accessors as Record<string, unknown>[];
        const meshes = doc.meshes as { primitives: Record<string, unknown>[] }[];
        // A second primitive reusing the POSITION and index accessors only.
        const first = meshes[0].primitives[0];
        meshes[0].primitives.push({
          attributes: { POSITION: 0 },
          indices: first.indices,
          mode: 4,
        });
        void accessors;
      },
    }),
  );
  assert.ok(report.mesh !== null);
  assert.equal(report.mesh.triangleCount, 2, 'both primitives should have loaded');
  assert.equal(report.mesh.normals, null, 'one primitive without normals drops the set');
  assert.equal(report.mesh.uvs, null, 'one primitive without UVs drops the set');
  // And the report agrees with the mesh rather than with what any one
  // primitive happened to carry.
  assert.equal(report.hasNormals, false);
  assert.equal(report.hasUvs, false);
});

test('a scene that omits its node list is empty, not everything', () => {
  // `nodes` is optional and its absence means an empty scene. Falling through
  // to "every node in the file" loads geometry the author excluded.
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        doc.scenes = [{}];
        doc.scene = 0;
        doc.nodes = [{ mesh: 0 }];
      },
    }),
  );
  assert.equal(report.mesh, null);
});

test('with no scenes at all, a child is not loaded twice', () => {
  // Every node is a candidate root, but visiting them all literally reaches the
  // child once through its parent and once from the top-level list -- the same
  // geometry twice, with the parent transform applied to only one copy.
  const report = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (doc) => {
        delete doc.scenes;
        delete doc.scene;
        doc.nodes = [{ children: [1] }, { mesh: 0 }];
      },
    }),
  );
  assert.equal(report.mesh?.triangleCount, 1);
});

test('a required extension this reader does not implement is refused by name', () => {
  // glTF 2.0 §3.2: a client that does not support everything in
  // `extensionsRequired` must not load the asset. Not pedantry -- an extension
  // may redefine what a buffer view MEANS. `EXT_meshopt_compression` does
  // exactly that, and a reader that ignored the declaration would read
  // compressed bytes as coordinates and hand back a surface that is well-formed,
  // plausible, and not the model in the file.
  const glb = buildGlb({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    patch: (d) => (d.extensionsRequired = ['EXT_meshopt_compression']),
  });
  const report = readGlb(glb);
  assert.equal(report.mesh, null, 'the asset must not load');
  assert.ok(
    report.skipped.some((t) => t.includes('EXT_meshopt_compression')),
    `the refusal must name the extension, got ${JSON.stringify(report.skipped)}`,
  );

  // And the list is what this reader is UNAFFECTED by, not what it implements:
  // a required material extension changes nothing about positions and indices,
  // so the same file loads.
  const material = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      patch: (d) => (d.extensionsRequired = ['KHR_materials_unlit']),
    }),
  );
  assert.ok(material.mesh !== null, 'a materials-only requirement must not block the geometry');
});

test('texture coordinates outside [0, 1] are wrapped, and the wrap is reported', () => {
  // `SurfaceMesh` says its UVs are in [0, 1]; glTF does not, because the default
  // sampler wrap is REPEAT and a tiled unwrap legitimately writes 2.5 or -0.25.
  // Passing those through breaks the boundary type where it bites: the Bourke
  // warp exporter writes a node's UV straight into the file, and a value outside
  // [0, 1] is that format's marker for "this node is not to be used". A tiled
  // facade would export as a mesh of holes.
  const glb = buildGlb({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    uvs: [2.5, -0.25, 1, 0, 0.5, 0.5],
  });
  const report = readGlb(glb);
  assert.ok(report.mesh?.uvs != null, 'the UV set must survive');
  const uv = report.mesh.uvs;
  const near = (got: number, want: number, what: string): void =>
    assert.ok(Math.abs(got - want) < 1e-6, `${what}: got ${got}, want ${want}`);
  near(uv[0], 0.5, '2.5 wraps to 0.5');
  near(uv[1], 0.75, '-0.25 wraps to 0.75');
  // An exact 1.0 is the right-hand edge of an atlas and is extremely common.
  // REPEAT would send it round to 0; inside the range nothing is touched.
  near(uv[2], 1, 'an exact 1 is left alone');
  near(uv[4], 0.5, 'a value already inside is untouched');

  for (const v of uv) assert.ok(v >= 0 && v <= 1, `uv ${v} escaped the boundary contract`);
  assert.ok(
    report.skipped.some((t) => t.includes('wrapped')),
    `the wrap must be reported, got ${JSON.stringify(report.skipped)}`,
  );

  // A file already inside the range says nothing, or the note is noise.
  const clean = readGlb(
    buildGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      uvs: [0, 0, 1, 0, 0.5, 1],
    }),
  );
  assert.equal(clean.skipped.some((t) => t.includes('wrapped')), false);
});
