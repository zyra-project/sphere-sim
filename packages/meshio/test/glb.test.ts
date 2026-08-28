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

test('a node cycle is a report rather than a stack overflow', () => {
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
  assert.ok(report.skipped.some((s) => s.includes('deeper than')));
});
