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
 * A ceiling on the merged mesh, expressed in BYTES rather than in vertices.
 *
 * Counting vertices was the previous version and it is not a memory bound. Each
 * one costs 24 bytes of `Float64Array` position plus 24 of normal plus 8 of UV,
 * and every one is staged in a plain `number[]` first — so 16 million vertices,
 * which sounded like a conservative cap, is about 900 MB of typed array and well
 * over a gigabyte at peak. `readGlb` runs on the page's main thread, so that is
 * a tab dying rather than a report.
 *
 * 192 MB is a model of roughly three million vertices: far past anything this
 * page traces interactively, and comfortably inside what a browser will hand a
 * single allocation without complaint.
 */
const MAX_OUTPUT_BYTES = 192 * 1024 * 1024;

/** Bytes one merged vertex costs: position + normal (float64) and UV (float32). */
const BYTES_PER_VERTEX = 3 * 8 + 3 * 8 + 2 * 4;

/**
 * Extensions a file may REQUIRE without this reader having to understand them.
 *
 * glTF 2.0 §3.2 is explicit: a client that does not support every extension in
 * `extensionsRequired` must not load the asset. That is not pedantry here. An
 * extension may redefine what a buffer view or an accessor MEANS --
 * `EXT_meshopt_compression` is exactly that -- and a reader that ignores the
 * declaration reads compressed bytes as coordinates and produces a surface that
 * is well-formed, plausible, and not the model.
 *
 * So the list is what this reader is provably UNAFFECTED by rather than what it
 * implements: everything here touches materials, textures or lights, and this
 * reader takes only positions, normals, UVs and indices. Anything else in
 * `extensionsRequired` -- including one that is harmless and simply not listed
 * yet -- is refused by name, which is a message somebody can act on.
 */
const IGNORABLE_REQUIRED_EXTENSIONS = [
  'KHR_materials_',
  'KHR_texture_',
  'KHR_lights_punctual',
  'KHR_materials_variants',
  'EXT_texture_',
];

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
function composeTrs(tRaw: unknown, rRaw: unknown, sRaw: unknown): Mat4 {
  // Each is optional in the spec and arbitrary in an uploaded file. A field of
  // the wrong shape falls back to the identity value for that component rather
  // than destructuring a number (which throws) or a short array (which yields
  // `undefined` and then a matrix of NaN).
  const [x, y, z, w] = asNumbers(rRaw, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = asNumbers(sRaw, 3) ?? [1, 1, 1];
  const [tx, ty, tz] = asNumbers(tRaw, 3) ?? [0, 0, 0];
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

/**
 * `JSON.parse` returns whatever was in the file, and the interface below is an
 * ASSERTION about it rather than a check.
 *
 * That distinction is the source of a whole class of fault in this reader and it
 * is worth stating where the type is declared. `nodes[i].children` is typed
 * `number[] | undefined`; in an uploaded file it can be a string, an object, or
 * a number, and `for (const c of node.children ?? [])` then throws a TypeError
 * — from a function whose contract is that a merely-unusable file produces a
 * report and never an exception. Measured before this was written: of ten
 * malformed documents, five threw and one produced a mesh with NaN positions.
 *
 * So every field read out of the document goes through one of these. They
 * coerce or refuse; they never trust the declared type.
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A plain object, which is what every `{ ... }` in the {@link Gltf} interface
 * merely CLAIMS its entries are.
 *
 * `null` is the one that catches people: it is an object to `typeof`, it is
 * legal JSON, and a document holding `meshes: [null]` reaches the code that
 * reads `.primitives` off it.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A texture coordinate brought into [0, 1], which is what `SurfaceMesh` says
 * its UVs are.
 *
 * glTF does not require them to be: the default sampler wrap is `REPEAT`, and a
 * tiled unwrap legitimately writes 2.5 or -0.25. Passing those through breaks
 * the boundary type's contract, and it breaks it in a place that bites --
 * `buildWarpExport` writes a node's texture coordinates straight into a Bourke
 * warp file, where a value outside [0, 1] is the format's marker for "this node
 * is not to be used". A tiled facade would export as a mesh of holes.
 *
 * Wrapping is what `REPEAT` does, so this reproduces the sampler rather than
 * inventing a policy. Values already inside the range are returned untouched,
 * which keeps an exact 1.0 -- the right-hand edge of an atlas, and extremely
 * common -- from wrapping round to the left-hand edge.
 */
function wrapUv(x: number): number {
  if (x >= 0 && x <= 1) return x;
  return x - Math.floor(x);
}

/** A finite number, or `null`. Rejects strings, NaN and Infinity alike. */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-negative whole number, or `null` — an index, a count, a byte length. */
function asIndex(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** `n` finite numbers, or `null` if the field is not that. */
function asNumbers(value: unknown, n: number): number[] | null {
  if (!Array.isArray(value) || value.length !== n) return null;
  const out: number[] = [];
  for (const v of value) {
    const f = asNumber(v);
    if (f === null) return null;
    out.push(f);
  }
  return out;
}

interface Gltf {
  extensionsRequired?: string[];
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
      // The parse itself, not just the shape of what it returns. The previous
      // round hardened every field read out of this object and left the call
      // that produces it bare -- so a valid GLB header wrapping malformed JSON
      // threw a raw SyntaxError out of a function whose contract is a report.
      // Hardening the object and not the parse is the same mistake one level up.
      try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end))) as Gltf;
      } catch (err) {
        return empty(
          `the JSON chunk is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        return empty('the JSON chunk is not a glTF document');
      }
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
  for (const required of asArray(json.extensionsRequired)) {
    const name = typeof required === 'string' ? required : String(required);
    if (IGNORABLE_REQUIRED_EXTENSIONS.some((ok) => name.startsWith(ok))) continue;
    return empty(
      `the file requires the ${name} extension, which this reader does not implement. ` +
        `Loading it anyway would read its data as though it were plain glTF and produce ` +
        `a model that looks right and is not the one in the file. Re-export without it.`,
    );
  }

  // `asArray`, not `json.buffers ?? []`. The declared type is an assertion over
  // `JSON.parse`, so `buffers: {}` is a legal document as far as this code is
  // concerned and `for...of` on it throws `TypeError: object is not iterable` --
  // out of a function whose contract is that a bad file becomes a report. An
  // array holding `null` throws the same way on `.uri`.
  for (const buffer of asArray(json.buffers)) {
    if (!isRecord(buffer)) continue;
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
  const readAccessor = (index: number, expectType?: string): Float64Array | null => {
    const acc = accessors[index];
    if (acc === undefined) return null;
    // The DECLARED type, not the length. Dividing a flat array by three does not
    // prove it held VEC3s: a VEC4 accessor of three elements has length 12,
    // reads as four vertices, and regroups somebody's `w` components into
    // positions. The glTF type is right there in the file and is the only thing
    // that answers the question.
    if (expectType !== undefined && acc.type !== expectType) {
      skipped.push(
        `an attribute is declared ${String(acc.type)} where ${expectType} is required`,
      );
      return null;
    }
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
    // Every one of these is a number in the type and anything at all in the
    // file. A string byteLength makes the extent checks below compare against
    // NaN, which is false every way round, so the read proceeds unbounded.
    const viewLen = asIndex(view.byteLength);
    const viewOff = asIndex(view.byteOffset ?? 0);
    const accOff = asIndex(acc.byteOffset ?? 0);
    if (viewLen === null || viewOff === null || accOff === null) return null;
    const strideRaw = view.byteStride === undefined ? comps * ct.size : asIndex(view.byteStride);
    if (strideRaw === null || strideRaw === 0) return null;
    const stride = strideRaw;
    const base = viewOff + accOff;
    // The view's own window, not just the BIN chunk. Checking only the chunk
    // lets a malformed accessor overread into the NEXT view and reinterpret
    // somebody else's bytes as geometry — which produces a plausible-looking
    // mesh rather than a refusal, and is the failure this reader least wants.
    const viewEnd = viewOff + viewLen;
    if (viewEnd > bin.byteLength) return null;
    if (acc.count > 0) {
      const last = base + (acc.count - 1) * stride + (comps - 1) * ct.size + ct.size;
      if (base < viewOff || last > viewEnd) return null;
    }
    const out = new Float64Array(acc.count * comps);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const at = base + i * stride + c * ct.size;
        let value = ct.read(dv, at);
        // Float components come out of the file, and `getFloat32` decodes NaN
        // and Infinity as happily as it decodes 1.0. A non-finite POSITION
        // poisons the bounds, the hierarchy, the camera and every coverage
        // figure -- and none of the JSON-shape checks above can see it, because
        // this value was never in the JSON. Integer component types cannot be
        // non-finite, so this only ever rejects a float that really is one.
        if (!Number.isFinite(value)) {
          skipped.push('an accessor holds a non-finite value; the primitive is dropped');
          return null;
        }
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
  /** Whether any TEXCOORD_0 value arrived outside [0, 1]. See `wrapUv`. */
  let wrappedUvs = false;

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
    // `attributes` is required by the spec and optional in a file somebody
    // uploaded. Reading `.POSITION` off `undefined` throws, from a function whose
    // whole contract is that a bad file produces a report.
    const attrs: Record<string, unknown> =
      prim.attributes !== null && typeof prim.attributes === 'object'
        ? (prim.attributes as Record<string, unknown>)
        : {};
    const posIndex = asIndex(attrs.POSITION);
    if (posIndex === null) {
      skippedPrimitives++;
      return;
    }
    const pos = readAccessor(posIndex, 'VEC3');
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
    const nrmIndex = asIndex(attrs.NORMAL);
    const nrmRaw = nrmIndex !== null ? readAccessor(nrmIndex, 'VEC3') : null;
    const uvIndex = asIndex(attrs.TEXCOORD_0);
    const uvRaw = uvIndex !== null ? readAccessor(uvIndex, 'VEC2') : null;
    // Exact, not `>=`: the type is now known, so a VEC3 normal accessor with a
    // different element count is a mismatch rather than a longer array to index
    // into.
    const nrm = nrmRaw !== null && nrmRaw.length === 3 * count ? nrmRaw : null;
    const uv = uvRaw !== null && uvRaw.length === 2 * count ? uvRaw : null;
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
    const idxIndex = asIndex(prim.indices);
    if (idxIndex !== null) {
      const idx = readAccessor(idxIndex, 'SCALAR');
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
    if ((positions.length / 3 + count) * BYTES_PER_VERTEX > MAX_OUTPUT_BYTES) {
      exhausted = true;
      if (!skipped.some((t) => t.includes('total size'))) {
        skipped.push(
          `the scene expands past ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))} MB of ` +
            `geometry; the rest of it is not read`,
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
        const u0 = uv[2 * i];
        const v0 = uv[2 * i + 1];
        if (u0 < 0 || u0 > 1 || v0 < 0 || v0 > 1) wrappedUvs = true;
        uvs.push(wrapUv(u0), wrapUv(v0));
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
    // Sixteen FINITE numbers, not merely something sixteen long: a string of
    // sixteen characters passes a length check and `Float64Array.from` turns it
    // into sixteen NaNs, which propagate into every vertex position.
    const matrix = asNumbers(node.matrix, 16);
    const local =
      matrix !== null
        ? (Float64Array.from(matrix) as Mat4)
        : composeTrs(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (isRecord(mesh)) {
        if (++instances > MAX_INSTANCES) {
          exhausted = true;
          skipped.push(
            `the scene expands to more than ${MAX_INSTANCES} mesh instances; ` +
              `it may repeat a subtree exponentially`,
          );
        } else {
          for (const prim of asArray(mesh.primitives)) {
            // Checked, not cast. `meshes: [{ primitives: [null] }]` is a legal
            // JSON document and reaches `prim.mode` as a throw otherwise.
            if (!isRecord(prim)) {
              skippedPrimitives++;
              continue;
            }
            emitPrimitive(
              prim as NonNullable<Gltf['meshes']>[number]['primitives'][number],
              world,
            );
          }
        }
      }
    }
    for (const child of asArray(node.children)) {
      const c = asIndex(child);
      if (c !== null) visit(c, world, depth + 1);
    }
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

  // Said rather than done quietly. The wrap reproduces the sampler the file
  // would have been rendered with, but it is still the reader deciding
  // something, and a UV set that needed it is a set somebody may want to look
  // at -- an atlas exported with tiling is one thing, a broken unwrap another.
  if (wrappedUvs && allUvs) {
    skipped.push(
      'some texture coordinates lay outside [0, 1] and were wrapped, as a REPEAT sampler would',
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
  if (scene !== undefined) {
    // An omitted `nodes` is an empty scene; a `nodes` of the wrong shape is a
    // malformed one, and both name no roots rather than throwing.
    return asArray(scene.nodes)
      .map(asIndex)
      .filter((n): n is number => n !== null);
  }
  const claimed = new Uint8Array(nodeCount);
  for (const node of asArray(json.nodes) as NonNullable<Gltf['nodes']>) {
    for (const child of asArray(node.children)) {
      const c = asIndex(child);
      if (c !== null && c < nodeCount) claimed[c] = 1;
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
