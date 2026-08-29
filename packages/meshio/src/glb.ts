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

/**
 * Ceilings on what a single uploaded file may ask this reader to allocate.
 *
 * Not tuning knobs — they are the difference between a refusal and an
 * out-of-memory kill of the worker, which is a blank page with no message.
 * Both are set well above any real model: 64M components is a 21-million-vertex
 * position accessor, and 65,536 mesh instances is more than a city block of
 * scattered props. A file that exceeds either is malformed or hostile, and both
 * deserve the same answer, which is a `MeshLoadReport` saying so.
 */
const MAX_ELEMENTS = 64 * 1024 * 1024;
const MAX_INSTANCES = 65536;

/**
 * A ceiling on the MERGED mesh, which is the one that actually bounds memory.
 *
 * The other two limits are per-accessor and per-instance and their product is
 * not a bound: a million-vertex mesh instanced three hundred times is under both
 * and is still gigabytes of Float64Array here. 16 million vertices is a model
 * far past anything this page can trace interactively, and the refusal names
 * itself rather than arriving as an out-of-memory kill of the worker.
 */
const MAX_OUTPUT_VERTICES = 16 * 1024 * 1024;

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
/**
 * What container these bytes are, by looking at them.
 *
 * `mediaKind` classifies a drop by extension and MIME because that is all it
 * has before the file is read, and it is deliberately generous: something named
 * `.gltf`, or arriving as `model/obj`, IS a model, and telling whoever dropped
 * it that their image has the wrong aspect ratio would be worse than useless.
 * The cost of that generosity is that {@link readGlb} then gets handed
 * containers it cannot read, and its refusal — "the magic is not glTF" — reads
 * as nonsense to somebody whose file is glTF, just not the binary flavour.
 *
 * So the caller sniffs first and says something true. Format knowledge lives
 * here rather than in the page.
 */
export function containerOf(input: ArrayBuffer | Uint8Array): 'glb' | 'gltf-json' | 'unknown' {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength >= 12) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(0, true) === MAGIC_GLTF) return 'glb';
  }
  // JSON glTF: the first non-whitespace byte of an object.
  for (let i = 0; i < Math.min(bytes.byteLength, 64); i++) {
    const c = bytes[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return c === 0x7b ? 'gltf-json' : 'unknown';
  }
  return 'unknown';
}

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

  /**
   * Read an accessor into a flat array of numbers.
   *
   * Every quantity here comes from JSON a stranger uploaded, so the order of
   * operations matters: the extent is checked BEFORE the output is allocated.
   * `count` is the size of an array this reader is about to create, and a
   * forty-byte file can ask for `count: 2e9` — sixteen gigabytes of Float64Array
   * — which fails as an out-of-memory kill of the worker rather than as a
   * report. Validating first turns that into `MAX_ELEMENTS` prose.
   */
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
    if (!Number.isSafeInteger(acc.count) || acc.count < 0) {
      skipped.push(`an accessor declares a count of ${acc.count}, which is not a whole number`);
      return null;
    }
    if (acc.count * comps > MAX_ELEMENTS) {
      skipped.push(
        `an accessor declares ${acc.count} elements; this reader stops at ` +
          `${Math.floor(MAX_ELEMENTS / comps)} for a ${acc.type}`,
      );
      return null;
    }
    if (acc.bufferView === undefined) return new Float64Array(acc.count * comps); // spec: absent view means zeros
    const view = bufferViews[acc.bufferView];
    if (view === undefined || bin === null) return null;
    const stride = view.byteStride ?? comps * ct.size;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    // The view's own window, not just the BIN chunk. Checking only the chunk
    // lets a malformed accessor overread into the NEXT view and reinterpret
    // somebody else's bytes as geometry — which produces a plausible-looking
    // mesh rather than a refusal, and is the failure this reader least wants.
    const viewEnd = (view.byteOffset ?? 0) + view.byteLength;
    if (viewEnd > bin.byteLength) return null;
    if (acc.count > 0) {
      const last = base + (acc.count - 1) * stride + (comps - 1) * ct.size + ct.size;
      if (base < (view.byteOffset ?? 0) || last > viewEnd) return null;
    }
    const out = new Float64Array(acc.count * comps);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const at = base + i * stride + c * ct.size;
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
  // ALL, not any. The policy at the bottom of this function is all-or-nothing
  // per file, and `any` produced precisely the failure that paragraph describes:
  // one primitive with normals and one without shipped the second primitive's
  // fabricated (0, 0, 0) as real data — a zero-length normal, which is worse
  // than an absent one — with the report claiming the whole mesh was shaded
  // from the file. The UV case is the same shape: the attribute-less faces all
  // sample texel (0, 0), so a building arrives with one wall the colour of a
  // single pixel.
  // Set once any ceiling is reached, so the walk stops emitting rather than
  // continuing to refuse one primitive at a time. Declared with the other
  // accumulators because `emitPrimitive` reads it.
  let exhausted = false;
  let allNormals = true;
  let allUvs = true;
  let accepted = 0;
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
    // An accessor that read is not yet an accessor that FITS. `readAccessor`
    // returns a flat array without saying how wide it is, so a NORMAL declared
    // VEC2, or a TEXCOORD_0 with half as many entries as there are vertices,
    // comes back non-null and shorter than the loop below reads — appending NaN
    // normals and undefined UVs into a mesh that then loads and shades wrong.
    // The shape is checked against POSITION rather than trusted.
    const nrmRaw =
      prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
    const uvRaw =
      prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
    const nrm = nrmRaw !== null && nrmRaw.length >= 3 * count ? nrmRaw : null;
    const uv = uvRaw !== null && uvRaw.length >= 2 * count ? uvRaw : null;
    if (nrmRaw !== null && nrm === null) {
      if (!skipped.some((t) => t.includes('NORMAL'))) {
        skipped.push(
          `a primitive's NORMAL holds ${nrmRaw.length} values for ${count} vertices; ` +
            `its normals are derived from the winding instead`,
        );
      }
    }
    if (uvRaw !== null && uv === null) {
      if (!skipped.some((t) => t.includes('TEXCOORD_0'))) {
        skipped.push(
          `a primitive's TEXCOORD_0 holds ${uvRaw.length} values for ${count} vertices; ` +
            `it is dropped, so the model has no content`,
        );
      }
    }

    // Indices are read and validated HERE, before a single vertex is appended.
    // The append is what cannot be undone cheaply: a primitive that fails after
    // pushing its positions leaves vertices no triangle references, and those
    // orphans are not inert — they enter the bounds, so they move the model's
    // centre, its radius, the preview framing and the blend scale, all from a
    // primitive that was reported as skipped.
    let tris: Uint32Array | null = null;
    if (prim.indices !== undefined) {
      const idx = readAccessor(prim.indices);
      if (idx === null) {
        skippedPrimitives++;
        return;
      }
      // Not rounded down. A count that is not a whole number of triangles is a
      // malformed primitive, and silently dropping the remainder accepts it --
      // appending its vertices, which are then orphans that still move the
      // bounds, the preview framing and the blend scale while contributing no
      // surface.
      if (idx.length === 0 || idx.length % 3 !== 0) {
        skippedPrimitives++;
        if (!skipped.some((t) => t.includes('whole triangles'))) {
          skipped.push(`a primitive has ${idx.length} indices, which is not whole triangles`);
        }
        return;
      }
      const n = idx.length;
      tris = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const v = idx[i];
        // An index outside this primitive's own vertices is not recoverable:
        // the BVH and the adjacency would read positions that were never
        // written and return distances and bounds computed from zeros.
        if (!Number.isInteger(v) || v < 0 || v >= count) {
          skippedPrimitives++;
          if (!skipped.some((t) => t.includes('index'))) {
            skipped.push(
              `a primitive has an index (${v}) outside its own ${count} vertices`,
            );
          }
          return;
        }
        tris[i] = v;
      }
    }

    // The instance ceiling does not bound this. Every accepted instance may
    // carry up to MAX_ELEMENTS of its own, so a million-vertex mesh instanced a
    // few hundred times sits under both limits and still expands to gigabytes
    // here. What has to be bounded is the OUTPUT, cumulatively, before it is
    // written.
    if (positions.length / 3 + count > MAX_OUTPUT_VERTICES) {
      exhausted = true;
      if (!skipped.some((t) => t.includes('total vertices'))) {
        skipped.push(
          `the scene expands past ${MAX_OUTPUT_VERTICES} total vertices; ` +
            `the rest of it is not read`,
        );
      }
      return;
    }

    const nm = normalMatrix(world);
    const base = positions.length / 3;
    // A node transform with a negative determinant MIRRORS the model, and a
    // mirror reverses triangle winding while the index buffer stays as written.
    // glTF permits a negative scale, so this is a legal file that would arrive
    // inside out: every face pointing away, nothing lit, and a preview that
    // still looks like a picture. The up-axis conversion is a rotation and
    // cannot cause it; only the node transform can.
    const flip = determinant3(world) < 0;

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
    accepted++;
    if (nrm === null) allNormals = false;
    if (uv === null) allUvs = false;

    if (tris !== null) {
      for (let i = 0; i + 2 < tris.length; i += 3) {
        pushTriangle(indices, base + tris[i], base + tris[i + 1], base + tris[i + 2], flip);
      }
    } else {
      for (let i = 0; i + 2 < count; i += 3) {
        pushTriangle(indices, base + i, base + i + 1, base + i + 2, flip);
      }
    }
  };

  // Walk the scene. A node may be reached twice through SEPARATE parents, which
  // is legal glTF and means the geometry is instanced — so a visited node is not
  // skipped. What must be caught is a node reached from ITSELF, and the two look
  // identical to a visited-set: the distinction is whether the repeat is on the
  // current path or beside it.
  //
  // A depth cap alone does not make this safe, which was the previous reading.
  // Nothing about 256 levels bounds the WORK: a node listing the same child
  // twice doubles the tree at every level, so a document of a few hundred bytes
  // expands to 2^256 visits and every one of them is legal, acyclic and under
  // the cap. Since this parser runs on a file a stranger dropped on the page,
  // the total is capped too, and the cap is on emitted instances because that is
  // the quantity that actually costs memory.
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const scene = json.scenes?.[json.scene ?? 0];
  const onPath = new Uint8Array(nodes.length);
  let instances = 0;
  const visit = (nodeIndex: number, parent: Mat4, depth: number): void => {
    if (exhausted) return;
    if (depth > 256) {
      if (!skipped.some((s) => s.includes('deeper than'))) {
        skipped.push('the node tree is deeper than 256 levels');
      }
      return;
    }
    const node = nodes[nodeIndex];
    if (node === undefined) return;
    if (onPath[nodeIndex] === 1) {
      if (!skipped.some((s) => s.includes('cycle'))) {
        skipped.push(`node ${nodeIndex} is its own ancestor; the node tree contains a cycle`);
      }
      return;
    }
    onPath[nodeIndex] = 1;
    const local =
      node.matrix !== undefined && node.matrix.length === 16
        ? (Float64Array.from(node.matrix) as Mat4)
        : composeTrs(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (mesh !== undefined) {
        if (++instances > MAX_INSTANCES) {
          exhausted = true;
          skipped.push(
            `the scene expands to more than ${MAX_INSTANCES} mesh instances; ` +
              `it may repeat a subtree exponentially`,
          );
        } else {
          for (const prim of mesh.primitives) emitPrimitive(prim, world);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
    onPath[nodeIndex] = 0;
  };

  for (const root of sceneRoots(json, nodes.length)) visit(root, identity(), 0);

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
    // lighting bug in the model. So one primitive without them drops the set
    // for the whole file and every face is shaded from its winding — which is
    // uniform, and therefore a surface rather than a seam.
    normals: accepted > 0 && allNormals ? Float64Array.from(normals) : null,
    uvs: accepted > 0 && allUvs ? Float32Array.from(uvs) : null,
    vertexCount,
    triangleCount: indices.length / 3,
  };

  return { mesh, format: 'glb', skipped, hasNormals: mesh.normals !== null, hasUvs: mesh.uvs !== null };
}

/**
 * Append a triangle, swapping two corners when the node transform mirrored it.
 *
 * The up-axis conversion `(x, y, z) -> (x, -z, y)` is a rotation and preserves
 * handedness, so it never sets `flip`. A node transform can: glTF permits a
 * negative scale, and a negative determinant turns every outward face inward
 * while the index buffer says otherwise. That failure is silent in the worst
 * way — the model loads, the preview draws a recognizable object, and the
 * coverage reads 0% because every normal points away. This repository has
 * already been bitten by exactly that signature once, from a hand-built
 * fixture, which is why it is worth a branch rather than a comment.
 */
function pushTriangle(out: number[], a: number, b: number, c: number, flip: boolean): void {
  if (flip) out.push(a, c, b);
  else out.push(a, b, c);
}

/**
 * Which nodes to start the walk from.
 *
 * Two cases the obvious `scene?.nodes ?? every node` conflates:
 *
 *   - **A scene that omits `nodes`.** The spec makes `nodes` optional, and its
 *     absence means an EMPTY scene — a file that deliberately shows nothing.
 *     Falling through to every node loads geometry the author excluded.
 *   - **A file with no `scenes` at all.** Then every node is a candidate root,
 *     but taking them all literally visits each child twice: once through its
 *     parent and once from the top-level list, which duplicates the geometry
 *     and applies the parent transform to only one of the copies. The roots are
 *     the nodes nobody claims as a child.
 */
function sceneRoots(json: Gltf, nodeCount: number): number[] {
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene !== undefined) return scene.nodes ?? [];
  const claimed = new Uint8Array(nodeCount);
  for (const node of json.nodes ?? []) {
    for (const child of node.children ?? []) {
      if (child >= 0 && child < nodeCount) claimed[child] = 1;
    }
  }
  const roots: number[] = [];
  for (let i = 0; i < nodeCount; i++) if (claimed[i] === 0) roots.push(i);
  return roots;
}

/** Determinant of a 4x4's upper-left 3x3 — negative means the map mirrors. */
function determinant3(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}
