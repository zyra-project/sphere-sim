// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Read a binary glTF file into a {@link SurfaceMesh}.
 *
 * ## Why this is its own package, and why neither model may import it
 *
 * `tools/boundary-lint.ts` R1: `packages/sim` and `packages/solver` may import
 * `packages/calibration` and nothing else. That is not negotiable and it is not
 * an inconvenience to route around — its own message names the failure mode, "a
 * shared helper package is how the boundary erodes: today it holds a PRNG, next
 * month it holds a distortion model, and every recovery score becomes circular."
 *
 * So a loader cannot live anywhere either model can reach. It lives here, and
 * the only thing it produces is DATA: the arrays `packages/calibration/src/mesh.ts`
 * defines. Whoever holds both models — `packages/bench`, `packages/web` — reads a
 * file with this and hands the result to each side, which then builds its own
 * acceleration structure and writes its own intersection routine.
 *
 * `test/boundary.test.ts` asserts that neither model imports this package, so the
 * rule is checked here as well as in the lint.
 *
 * ## What it reads
 *
 * Binary glTF 2.0 — the `.glb` container: a 12-byte header, a JSON chunk, and an
 * optional binary chunk. GLB before `.gltf` because it is one file rather than a
 * JSON document plus a `.bin` plus whatever textures, and a browser file drop
 * hands over one file.
 *
 * Triangles only. A glTF scene routinely carries lines, points, and non-triangle
 * modes that a projection surface has no use for; those are counted and named in
 * {@link MeshLoadReport.skipped} rather than dropped in silence, because a model
 * that arrives with half its geometry missing must say so — otherwise somebody
 * studies a coverage map of a shape that is not the one they loaded.
 *
 * ## Two conversions that are easy to get wrong and invisible when wrong
 *
 * **The node hierarchy.** Geometry in a glTF is placed by a tree of nodes, each
 * carrying a transform. Exporters routinely leave a mesh under a scaled or
 * rotated parent. Reading `meshes[]` and ignoring `nodes[]` produces a model that
 * loads, renders, and sits in the wrong place at the wrong size — so this walks
 * the scene and accumulates the transform.
 *
 * **The up axis.** glTF is Y-up (spec §3.4: "the Y axis points up"). This
 * repository is Z-up — conventions.ts §W puts world +Z toward the ceiling and the
 * whole rig, the floor plane and the polar mask are written against that. A
 * loader that skipped the conversion would lay every model on its side, which
 * reads as "the exporter is odd" rather than as a bug in the reader. See
 * {@link GlbOptions.upAxis}.
 */

import type { MeshLoadReport, SurfaceMesh } from '../../calibration/src/index.ts';

const MAGIC_GLTF = 0x46546c67; // 'glTF', little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** glTF `primitive.mode`. Only TRIANGLES carries a surface. */
const MODE_TRIANGLES = 4;
const MODE_NAMES = [
  'POINTS',
  'LINES',
  'LINE_LOOP',
  'LINE_STRIP',
  'TRIANGLES',
  'TRIANGLE_STRIP',
  'TRIANGLE_FAN',
];

/** glTF `accessor.componentType`. */
const COMPONENT_TYPES = new Map<number, { size: number; read: ComponentReader }>([
  [5120, { size: 1, read: (dv, o) => dv.getInt8(o) }],
  [5121, { size: 1, read: (dv, o) => dv.getUint8(o) }],
  [5122, { size: 2, read: (dv, o) => dv.getInt16(o, true) }],
  [5123, { size: 2, read: (dv, o) => dv.getUint16(o, true) }],
  [5125, { size: 4, read: (dv, o) => dv.getUint32(o, true) }],
  [5126, { size: 4, read: (dv, o) => dv.getFloat32(o, true) }],
]);

type ComponentReader = (dv: DataView, offset: number) => number;

const TYPE_COMPONENTS = new Map<string, number>([
  ['SCALAR', 1],
  ['VEC2', 2],
  ['VEC3', 3],
  ['VEC4', 4],
  ['MAT4', 16],
]);

export interface GlbOptions {
  /**
   * Which axis the FILE treats as up.
   *
   * `'y'` — the glTF default, and what every conforming exporter writes. The
   * reader rotates the model a quarter turn about +X so that the file's +Y
   * becomes the world's +Z, matching conventions.ts §W.
   *
   * `'z'` — the file is already Z-up. Some CAD and GIS pipelines export this way
   * in violation of the spec, and a user who knows their model is one of them
   * should be able to say so rather than rotate it back by hand.
   */
  upAxis?: 'y' | 'z';
  /** Name for the resulting mesh. Defaults to the file's own scene or mesh name. */
  name?: string;
}

/** A 4x4 column-major transform, as glTF stores one. */
type Mat4 = Float64Array;

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** `a * b`, column-major, applied as `a` after `b`. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** glTF TRS -> a matrix. Rotation is a quaternion `[x, y, z, w]`. */
function composeTrs(
  t: readonly number[] | undefined,
  r: readonly number[] | undefined,
  s: readonly number[] | undefined,
): Mat4 {
  const [x, y, z, w] = r ?? [0, 0, 0, 1];
  const [sx, sy, sz] = s ?? [1, 1, 1];
  const [tx, ty, tz] = t ?? [0, 0, 0];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[4] = (xy - wz) * sy;
  m[5] = (1 - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[8] = (xz + wy) * sz;
  m[9] = (yz - wx) * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  m[15] = 1;
  return m;
}

/**
 * The matrix normals transform by: the inverse transpose of the upper-left 3x3.
 *
 * NOT the transform itself. Under a non-uniform scale a normal carried through
 * the position transform stops being perpendicular to its surface, and every
 * `dot(normal, toLens)` downstream — incidence, coverage, shading — is then
 * quietly wrong on exactly the models a projection-mapping user is most likely
 * to load, because squashing a primitive is how set pieces get built.
 *
 * Returns the upper 3x3 unchanged when it is singular, which is the best
 * available answer for a degenerate transform and keeps the numbers finite.
 */
function normalMatrix(m: Mat4): Float64Array {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[4];
  const e = m[5];
  const f = m[6];
  const g = m[8];
  const h = m[9];
  const i = m[10];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const out = new Float64Array(9);
  if (det === 0) {
    out[0] = a; out[1] = b; out[2] = c;
    out[3] = d; out[4] = e; out[5] = f;
    out[6] = g; out[7] = h; out[8] = i;
    return out;
  }
  const inv = 1 / det;
  // inverse, then transpose — written out together so there is one pass and no
  // intermediate to get the index order wrong in.
  out[0] = (e * i - f * h) * inv;
  out[3] = (c * h - b * i) * inv;
  out[6] = (b * f - c * e) * inv;
  out[1] = (f * g - d * i) * inv;
  out[4] = (a * i - c * g) * inv;
  out[7] = (c * d - a * f) * inv;
  out[2] = (d * h - e * g) * inv;
  out[5] = (b * g - a * h) * inv;
  out[8] = (a * e - b * d) * inv;
  return out;
}

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[]; name?: string }[];
  nodes?: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    name?: string;
  }[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
      extensions?: Record<string, unknown>;
    }[];
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    sparse?: unknown;
  }[];
  bufferViews?: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
  buffers?: { byteLength: number; uri?: string }[];
}

/**
 * Parse a `.glb` into a mesh.
 *
 * Never throws for a file that is merely unusable — a bad file is a report with
 * `mesh: null` and a reason in `skipped`, because this runs behind a drag and
 * drop and "tell the user what is wrong with their model" is the job. It DOES
 * throw for a container that is not a GLB at all, which is a programming error
 * in the caller rather than a property of the model.
 */
export function readGlb(input: ArrayBuffer | Uint8Array, options: GlbOptions = {}): MeshLoadReport {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const skipped: string[] = [];
  const empty = (reason: string): MeshLoadReport => {
    skipped.push(reason);
    return { mesh: null, format: 'glb', skipped, hasNormals: false, hasUvs: false };
  };

  if (bytes.byteLength < 12) throw new Error('not a GLB: fewer than 12 bytes');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== MAGIC_GLTF) {
    throw new Error('not a GLB: the magic is not "glTF"');
  }
  const version = header.getUint32(4, true);
  if (version !== 2) return empty(`glTF version ${version} is not supported; this reads glTF 2.0`);

  // Chunks. The spec requires JSON first and permits one BIN; anything else is
  // an extension chunk a conforming reader must ignore.
  let json: Gltf | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.byteLength) return empty('a chunk runs past the end of the file');
    if (type === CHUNK_JSON && json === null) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end))) as Gltf;
    } else if (type === CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, end);
    }
    // Chunks are padded to a four-byte boundary.
    offset = end + ((4 - (length % 4)) % 4);
  }
  if (json === null) return empty('no JSON chunk');

  // A buffer with a `uri` lives outside the file. That is legal glTF and this
  // reader cannot follow it: a drag and drop hands over one file, and quietly
  // reading a second one off disk or the network is not something a loader
  // should do on its own.
  for (const buffer of json.buffers ?? []) {
    if (buffer.uri !== undefined) {
      return empty('the file references an external buffer by URI; export as self-contained GLB');
    }
  }

  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];

  /** Read an accessor into a flat array of numbers. */
  const readAccessor = (index: number): Float64Array | null => {
    const acc = accessors[index];
    if (acc === undefined) return null;
    if (acc.sparse !== undefined) {
      skipped.push('an accessor uses sparse storage, which this reader does not implement');
      return null;
    }
    const comps = TYPE_COMPONENTS.get(acc.type);
    const ct = COMPONENT_TYPES.get(acc.componentType);
    if (comps === undefined || ct === undefined) {
      skipped.push(`accessor type ${acc.type}/${acc.componentType} is not supported`);
      return null;
    }
    const out = new Float64Array(acc.count * comps);
    if (acc.bufferView === undefined) return out; // spec: absent view means zeros
    const view = bufferViews[acc.bufferView];
    if (view === undefined || bin === null) return null;
    const stride = view.byteStride ?? comps * ct.size;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const at = base + i * stride + c * ct.size;
        if (at + ct.size > bin.byteLength) return null;
        let value = ct.read(dv, at);
        // glTF `normalized`: integer attributes stand for a value in [0, 1] or
        // [-1, 1]. UVs and normals are routinely stored this way to halve a file,
        // and reading the raw integer instead puts texture coordinates in the
        // tens of thousands.
        if (acc.normalized === true) {
          if (acc.componentType === 5121) value /= 255;
          else if (acc.componentType === 5123) value /= 65535;
          else if (acc.componentType === 5120) value = Math.max(value / 127, -1);
          else if (acc.componentType === 5122) value = Math.max(value / 32767, -1);
        }
        out[i * comps + c] = value;
      }
    }
    return out;
  };

  // Accumulate every triangle primitive the scene reaches, in world order.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let anyNormals = false;
  let anyUvs = false;
  let skippedPrimitives = 0;

  const yUp = (options.upAxis ?? 'y') === 'y';

  const emitPrimitive = (
    prim: NonNullable<Gltf['meshes']>[number]['primitives'][number],
    world: Mat4,
  ): void => {
    const mode = prim.mode ?? MODE_TRIANGLES;
    if (mode !== MODE_TRIANGLES) {
      skippedPrimitives++;
      const name = MODE_NAMES[mode] ?? `mode ${mode}`;
      if (!skipped.some((s) => s.includes(name))) {
        skipped.push(`a primitive uses ${name}; only TRIANGLES carries a surface`);
      }
      return;
    }
    if (prim.extensions?.KHR_draco_mesh_compression !== undefined) {
      skippedPrimitives++;
      if (!skipped.some((s) => s.includes('Draco'))) {
        skipped.push('a primitive is Draco-compressed; re-export without Draco');
      }
      return;
    }
    const posIndex = prim.attributes.POSITION;
    if (posIndex === undefined) {
      skippedPrimitives++;
      return;
    }
    const pos = readAccessor(posIndex);
    if (pos === null) {
      skippedPrimitives++;
      return;
    }
    const count = pos.length / 3;
    const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
    const uv =
      prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;

    const nm = normalMatrix(world);
    const base = positions.length / 3;

    for (let i = 0; i < count; i++) {
      const x = pos[3 * i];
      const y = pos[3 * i + 1];
      const z = pos[3 * i + 2];
      const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
      const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
      const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
      // Y-up -> Z-up: a quarter turn about +X, so the file's +Y becomes world +Z.
      if (yUp) positions.push(wx, -wz, wy);
      else positions.push(wx, wy, wz);

      if (nrm !== null) {
        const nx0 = nrm[3 * i];
        const ny0 = nrm[3 * i + 1];
        const nz0 = nrm[3 * i + 2];
        const nx = nm[0] * nx0 + nm[3] * ny0 + nm[6] * nz0;
        const ny = nm[1] * nx0 + nm[4] * ny0 + nm[7] * nz0;
        const nz = nm[2] * nx0 + nm[5] * ny0 + nm[8] * nz0;
        const len = Math.hypot(nx, ny, nz);
        const s = len > 0 ? 1 / len : 0;
        if (yUp) normals.push(nx * s, -nz * s, ny * s);
        else normals.push(nx * s, ny * s, nz * s);
      } else {
        normals.push(0, 0, 0);
      }

      if (uv !== null) {
        uvs.push(uv[2 * i], uv[2 * i + 1]);
      } else {
        uvs.push(0, 0);
      }
    }
    if (nrm !== null) anyNormals = true;
    if (uv !== null) anyUvs = true;

    if (prim.indices !== undefined) {
      const idx = readAccessor(prim.indices);
      if (idx === null) {
        skippedPrimitives++;
        return;
      }
      for (let i = 0; i + 2 < idx.length; i += 3) {
        pushTriangle(indices, base + idx[i], base + idx[i + 1], base + idx[i + 2], yUp);
      }
    } else {
      for (let i = 0; i + 2 < count; i += 3) {
        pushTriangle(indices, base + i, base + i + 1, base + i + 2, yUp);
      }
    }
  };

  // Walk the scene. A node may be reached twice through separate parents, which
  // is legal and means the geometry is instanced — so nodes are not marked
  // visited, but a cycle would not terminate, and glTF forbids one. The depth cap
  // makes a malformed file a report rather than a stack overflow.
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const visit = (nodeIndex: number, parent: Mat4, depth: number): void => {
    if (depth > 256) {
      if (!skipped.some((s) => s.includes('deeper than'))) {
        skipped.push('the node tree is deeper than 256 levels; it may contain a cycle');
      }
      return;
    }
    const node = nodes[nodeIndex];
    if (node === undefined) return;
    const local =
      node.matrix !== undefined && node.matrix.length === 16
        ? (Float64Array.from(node.matrix) as Mat4)
        : composeTrs(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (mesh !== undefined) for (const prim of mesh.primitives) emitPrimitive(prim, world);
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };

  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  const roots = scene?.nodes ?? nodes.map((_, i) => i);
  for (const root of roots) visit(root, identity(), 0);

  if (indices.length === 0) {
    return empty(
      skippedPrimitives > 0
        ? 'no TRIANGLES primitive survived; see the other entries'
        : 'the file contains no geometry',
    );
  }

  const vertexCount = positions.length / 3;
  const mesh: SurfaceMesh = {
    schema: 'sphere-sim/surface-mesh@1',
    name: options.name ?? scene?.name ?? meshes[0]?.name ?? 'model',
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    // All-or-nothing per file: a mesh whose normals are present on some
    // primitives and absent on others would shade half of itself from the file
    // and half from the winding, and the seam between them would look like a
    // lighting bug in the model.
    normals: anyNormals ? Float64Array.from(normals) : null,
    uvs: anyUvs ? Float32Array.from(uvs) : null,
    vertexCount,
    triangleCount: indices.length / 3,
  };

  return { mesh, format: 'glb', skipped, hasNormals: anyNormals, hasUvs: anyUvs };
}

/**
 * Append a triangle, flipping the winding when the model was mirrored by the
 * up-axis conversion.
 *
 * `(x, y, z) -> (x, -z, y)` is a rotation, and a rotation preserves handedness,
 * so the winding is untouched — this exists to say so at the one place a reader
 * would otherwise wonder, and to be the single line that changes if a mirroring
 * conversion is ever added.
 */
function pushTriangle(out: number[], a: number, b: number, c: number, _yUp: boolean): void {
  out.push(a, b, c);
}
