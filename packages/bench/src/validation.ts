/**
 * The validation page: photographs of real SOS installations beside our render.
 *
 *     node packages/bench/src/validation.ts        # regenerate validation/index.html
 *
 * ## What this is NOT
 *
 * **Not part of the optimization loop. Not read by any critic.** Nothing here
 * feeds a metric, a gate, a score or `bench-results.json`. No number produced on
 * this page may move a constant. `validation/README.md` opens with that sentence
 * and it is repeated here because the file lives in `packages/bench`, which is
 * otherwise the scorer, and proximity is how a rule gets forgotten.
 *
 * Its only job is plausibility. If our render looks nothing like a real sphere,
 * the model is broken no matter how good the numbers look — and every gate in
 * PARAMETERS.md §7 is a statement about a model that does not describe the thing
 * on the floor.
 *
 * ## Images are never fetched
 *
 * Nothing in this module opens a socket. There is no download, no scrape, no
 * cache, no URL. The project owner drops files into `validation/photos/` and adds
 * a row to `validation/sources.json`; this module reads the local directory and
 * nothing else. NOAA imagery is generally public domain, but photographs
 * submitted to NOAA by individual SOS sites may not be, so provenance is
 * `unknown` until the owner says otherwise and an `unknown` image renders under
 * an explicit "not for redistribution" banner.
 *
 * ## Why photographs are REFERENCED and not inlined
 *
 * `progress.ts` inlines every PNG as a `data:` URI because it is our own output
 * and the page has to survive being emailed. This page must not: inlining a
 * photograph whose provenance is unverified would copy it into a generated HTML
 * file that may be committed, attached or published, which is precisely the
 * redistribution the banner warns against. So photographs are referenced by a
 * relative path and stay in `validation/photos/` where the owner put them.
 *
 * Our OWN renders are inlined, because they are ours.
 *
 * The page still makes no external request: every reference is either a `data:`
 * URI or a relative path inside `validation/`. `test/validation.test.ts` asserts
 * there is no scheme-bearing URL anywhere in the output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import type { ChannelTriplet } from '../../calibration/src/index.ts';
import type { EquirectImage, RgbImage } from '../../sim/src/equirect.ts';
import { createImage, flatField, gridAlignmentPattern } from '../../sim/src/equirect.ts';
import { prepareRig } from '../../sim/src/optics.ts';
import { defaultScene, renderRoomView, viewerAt } from '../../sim/src/render.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import { nominalRig } from '../../sim/src/scene.ts';
import { fullShading } from '../../sim/src/shading.ts';
import { encodePng8 } from '../../sim/src/png.ts';

export const VALIDATION_SCHEMA = 'sphere-sim/validation-page@1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const VALIDATION_DIR = path.join(REPO_ROOT, 'validation');

/** The four provenance values `validation/README.md` allows. */
export const PROVENANCE_VALUES = ['public-domain', 'licensed', 'owner-supplied', 'unknown'] as const;
export type Provenance = (typeof PROVENANCE_VALUES)[number];

export interface SourceEntry {
  file: string;
  provenance: string;
  credit?: string;
  site?: string;
  dataset?: string;
  notes?: string;
}

export interface SourcesFile {
  note?: string;
  images: SourceEntry[];
}

export interface PhotoRecord {
  entry: SourceEntry;
  /** Relative href from the page, or `null` when the named file is not there. */
  href: string | null;
  /**
   * The provenance as parsed. A value outside the four allowed ones is reported
   * as `unknown` — the strictest reading, because a typo must not be able to
   * upgrade an image's licence.
   */
  provenance: Provenance;
  /** True when `entry.provenance` was not one of the four allowed values. */
  provenanceMalformed: boolean;
  /** `data:` URI of OUR render of the same dataset, or `null`. */
  pairRender: string | null;
  /** Why there is no pair render, when there is not. */
  pairReason: string;
  problems: string[];
}

export interface ReferenceRender {
  id: string;
  title: string;
  /** What a reader should compare against a photograph, and what would be a bug. */
  lookFor: string;
  dataUri: string;
}

export interface ValidationInput {
  sources: SourcesFile;
  photos: PhotoRecord[];
  /** Files in `validation/photos/` with no row in `sources.json`. Not rendered. */
  unlisted: string[];
  reference: ReferenceRender[];
  generatedAt: string;
  /** Whether `validation/sources.json` could be read and parsed. */
  sourcesError: string | null;
}

// ---------------------------------------------------------------------------
// A minimal PNG reader, so "our render of the same dataset" is real
// ---------------------------------------------------------------------------

/**
 * Decode an 8- or 16-bit non-interlaced PNG into a LINEAR float image.
 *
 * Written by hand for the same reason `png.ts` writes them by hand: zero runtime
 * dependencies is a project rule. It covers colour types 0 (grey), 2 (RGB) and
 * 6 (RGBA), which is what an equirectangular dataset export is; palette and
 * interlaced files are refused with a message that says what to convert to
 * rather than producing a plausible wrong picture.
 *
 * `sourceGamma` is the transfer the file was encoded with. 2.2 matches
 * `png.ts`'s default and is the right assumption for a dataset exported for
 * display. It is an ASSUMPTION about someone else's file, so the page says so
 * next to any render that used it.
 */
export function decodePng(buffer: Uint8Array, sourceGamma = 2.2): EquirectImage {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== sig[i]) throw new Error('not a PNG file (signature mismatch)');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= buffer.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7],
    );
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = buffer[offset + 16];
      colorType = buffer[offset + 17];
      if (buffer[offset + 20] !== 0) {
        throw new Error('interlaced PNG is not supported; save without Adam7 interlacing');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (width <= 0 || height <= 0) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`PNG bit depth ${bitDepth} is not supported; use 8 or 16 bits per channel`);
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) {
    throw new Error(
      `PNG colour type ${colorType} is not supported (palette and grey+alpha are not); ` +
        `save as RGB or RGBA`,
    );
  }

  const raw = zlib.inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const out = createImage(width, height);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const maxValue = bitDepth === 8 ? 255 : 65535;

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    line.set(raw.subarray(src, src + stride));
    src += stride;
    unfilter(filter, line, prev, bpp);
    for (let x = 0; x < width; x++) {
      const base = x * bpp;
      const read = (c: number): number => {
        const o = base + c * bytesPerSample;
        return bitDepth === 8 ? line[o] : (line[o] << 8) | line[o + 1];
      };
      const r = read(0) / maxValue;
      const g = channels === 1 ? r : read(1) / maxValue;
      const b = channels === 1 ? r : read(2) / maxValue;
      const i = 3 * (y * width + x);
      // Encoded file -> LINEAR light. Everything downstream of here is linear
      // (conventions.ts §P) and a texture loaded from an 8-bit file that skipped
      // this step is wrong by the whole transfer curve.
      out.data[i] = Math.pow(r, sourceGamma);
      out.data[i + 1] = Math.pow(g, sourceGamma);
      out.data[i + 2] = Math.pow(b, sourceGamma);
    }
    prev.set(line);
  }
  return out;
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter type ${filter}`);
  }
}

// ---------------------------------------------------------------------------
// Our renders
// ---------------------------------------------------------------------------

const RENDER_W = 384;
const RENDER_H = 288;
const RENDER_SPP = 3;

function dataUri(img: RgbImage, exposure = 1): string {
  return `data:image/png;base64,${encodePng8(img, { exposure, displayGamma: 2.2 }).toString('base64')}`;
}

function grey(v: number): ChannelTriplet {
  return { r: v, g: v, b: v };
}

/**
 * A room view of the nominal rig, for a reader to hold up next to a photograph.
 *
 * `fullShading` rather than `lambertian-v1`, because §1's specular lobe is part
 * of what a photograph shows and the whole question here is whether our picture
 * looks like a real sphere. Every constant behind the appearance of these images
 * is class ASSUME — the page says so on every panel.
 */
function roomRender(
  image: EquirectImage,
  eyeHeightM: number,
  distanceM: number,
  azimuthDeg: number,
  exposure: number,
  sceneOverrides: Partial<Scene> = {},
): string {
  const rig = nominalRig();
  const prepared = prepareRig(rig);
  const scene = defaultScene(image, sceneOverrides);
  const camera: ViewerCamera = viewerAt(
    azimuthDeg,
    distanceM,
    eyeHeightM,
    rig.sphere.centerHeightM,
    RENDER_W,
    RENDER_H,
    50,
  );
  const img = renderRoomView(prepared, scene, camera, {
    samplesPerPixel: RENDER_SPP,
    seed: 7,
    drawFloor: true,
    shading: fullShading(),
  });
  return dataUri(img, exposure);
}

/**
 * The four renders the evidence checklist refers to.
 *
 * Chosen to make each checklist row answerable from a picture: the graticule for
 * the mask boundary and for registration, the flat mid-gray for the seams (§8
 * item 13 prescribes exactly that frame), the same at a child's eye height
 * because §6 says run both and the masked pole is far more visible from there,
 * and a black field at high exposure for the floor spill.
 */
export function referenceRenders(): ReferenceRender[] {
  const graticule = gridAlignmentPattern({
    width: 2048,
    height: 1024,
    spacingDeg: 10,
    lineWidthDeg: 0.5,
  });
  const midGray = flatField(64, 32, grey(0.5));
  const black = flatField(16, 8, grey(0));

  return [
    {
      id: 'graticule-adult',
      title: 'Graticule, adult viewer (§6: h_eye 1.60 m, d_view 2.5 m, on a seam)',
      lookFor:
        'Where the bottom mask cuts the graticule off. PARAMETERS.md §4.4 reads `set bottommask 60,70` as ' +
        'LATITUDE and marks the reading inferred; docs/AMENDMENTS.md A-02 records that the same numbers read ' +
        'as colatitude would roughly triple the protected region. In a photograph, count graticule lines up ' +
        'from the bottom of the lit area and read the boundary latitude directly.',
      dataUri: roomRender(graticule, 1.6, 2.5, 45, 1),
    },
    {
      id: 'graticule-child',
      title: 'Graticule, child viewer (§6: h_eye 1.15 m, d_view 2.0 m)',
      lookFor:
        'The same boundary from the eye height §6 insists on running: the equator sits at 2.18 m so a child ' +
        'looks up steeply and sees far more of the masked polar region than an adult does. If a photograph ' +
        'was taken by an adult standing back, it under-samples exactly the region the mask governs.',
      dataUri: roomRender(graticule, 1.15, 2.0, 45, 1),
    },
    {
      id: 'midgray-seams',
      title: 'Flat mid-gray, all projectors (§8 item 13 — the blend characterization frame)',
      lookFor:
        'Seam structure. §3.2’s central claim is that the visible artifact is a COLOURED band, not a bright ' +
        'or dark one, produced by per-channel gamma divergence that no scalar correction can remove. In a ' +
        'photograph of a flat field: is the seam brighter, darker, or a different HUE from its surroundings? ' +
        'A hue difference is evidence for §3.2. A pure luminance step is evidence for a gain mismatch instead.',
      dataUri: roomRender(midGray, 1.6, 2.5, 45, 1),
    },
    {
      id: 'black-floor',
      title: 'Full black, projectors ON, exposure ×8 (§8 item 8)',
      lookFor:
        'The rectangle of glow on the floor around the sphere. More than half of every projector’s flux misses ' +
        'the sphere (§7, A-01) and in a real room that light lands somewhere; what a silhouette-masked ' +
        'projector puts there is exactly its black floor, `gain × L_black`. This is the most recognizable ' +
        'feature of a real SOS room photograph, and its BRIGHTNESS relative to the sphere is the closest thing ' +
        'to a free reading of `L_black` a photograph can give.',
      dataUri: roomRender(black, 1.6, 2.5, 45, 8),
    },
  ];
}

// ---------------------------------------------------------------------------
// Reading the local directory. No network, ever.
// ---------------------------------------------------------------------------

export function parseProvenance(raw: unknown): { value: Provenance; malformed: boolean } {
  if (typeof raw === 'string' && (PROVENANCE_VALUES as readonly string[]).includes(raw)) {
    return { value: raw as Provenance, malformed: false };
  }
  // Anything else is `unknown`. A typo must never be able to upgrade a licence.
  return { value: 'unknown', malformed: true };
}

export interface CollectOptions {
  validationDir?: string;
  /** Render our simulation of a matching dataset. Off in tests that only need the shell. */
  renderPairs?: boolean;
}

export function collectValidationInput(options: CollectOptions = {}): ValidationInput {
  const dir = options.validationDir ?? VALIDATION_DIR;
  const photosDir = path.join(dir, 'photos');
  const datasetsDir = path.join(dir, 'datasets');
  const generatedAt = new Date().toISOString();

  let sources: SourcesFile = { images: [] };
  let sourcesError: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
    const images = Array.isArray(raw?.images) ? raw.images : [];
    sources = { note: typeof raw?.note === 'string' ? raw.note : undefined, images };
    if (!Array.isArray(raw?.images)) {
      sourcesError = 'sources.json has no `images` array; treating it as empty.';
    }
  } catch (err) {
    sourcesError = `sources.json could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }

  const onDisk = new Set(
    fs.existsSync(photosDir)
      ? fs.readdirSync(photosDir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(photosDir, f)).isFile())
      : [],
  );

  const photos: PhotoRecord[] = sources.images.map((entry) => {
    const problems: string[] = [];
    const name = typeof entry.file === 'string' ? entry.file : '';
    if (name === '') problems.push('the row has no `file`, so no image can be matched to it');
    // A row must name a plain file inside photos/, never a path out of it.
    const unsafe = name.includes('/') || name.includes('\\') || name.includes('..');
    if (unsafe) problems.push('`file` must be a bare filename inside validation/photos/');
    const present = !unsafe && name !== '' && onDisk.has(name);
    if (!present && !unsafe && name !== '') {
      problems.push(`sources.json lists "${name}" but validation/photos/ does not contain it`);
    }
    const { value, malformed } = parseProvenance(entry.provenance);
    if (malformed) {
      problems.push(
        `provenance "${String(entry.provenance)}" is not one of ${PROVENANCE_VALUES.join(', ')}; ` +
          `treated as unknown`,
      );
    }

    let pairRender: string | null = null;
    let pairReason = 'no `dataset` named in sources.json, so there is nothing to pair against';
    const dataset = typeof entry.dataset === 'string' ? entry.dataset.trim() : '';
    if (dataset !== '') {
      const candidate = findDataset(datasetsDir, dataset);
      if (candidate === null) {
        pairReason =
          `dataset "${dataset}" is named but no matching file is in validation/datasets/ ` +
          `(looked for ${dataset}.png and ${dataset})`;
      } else if (!candidate.toLowerCase().endsWith('.png')) {
        pairReason =
          `dataset file ${path.basename(candidate)} is not a PNG. This project has zero runtime ` +
          `dependencies, so only PNG can be decoded — convert the equirectangular source to PNG.`;
      } else if (options.renderPairs === false) {
        pairReason = 'pair rendering disabled for this run';
      } else {
        try {
          const image = decodePng(fs.readFileSync(candidate));
          pairRender = roomRender(image, 1.6, 2.5, 45, 1);
          pairReason = '';
        } catch (err) {
          pairReason = `dataset ${path.basename(candidate)} could not be decoded: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }

    return {
      entry: { ...entry, file: name },
      href: present ? `photos/${name}` : null,
      provenance: value,
      provenanceMalformed: malformed,
      pairRender,
      pairReason,
      problems,
    };
  });

  const listed = new Set(photos.map((p) => p.entry.file));
  const unlisted = [...onDisk].filter((f) => !listed.has(f)).sort();

  return {
    sources,
    photos,
    unlisted,
    reference: options.renderPairs === false ? [] : referenceRenders(),
    generatedAt,
    sourcesError,
  };
}

/**
 * Find the dataset file a `sources.json` row names.
 *
 * The directory is SCANNED rather than probed for `name.png`, so a dataset the
 * owner dropped in as a JPEG is found and reported as "convert this to PNG"
 * instead of as "no such dataset". The difference matters: the second message
 * sends somebody looking for a missing file that is sitting right there.
 *
 * A name containing a separator or `..` is refused outright rather than
 * resolved, because a `dataset` field is a label and never a path.
 */
function findDataset(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const wanted = name.toLowerCase();
  let fallback: string | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (!fs.statSync(full).isFile()) continue;
    const lower = entry.toLowerCase();
    const stem = lower.slice(0, lower.length - path.extname(lower).length);
    if (lower === wanted || stem === wanted) {
      if (lower.endsWith('.png')) return full;
      fallback = fallback ?? full;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The checklist from `validation/README.md`, with what each row bears on. */
export interface EvidenceRow {
  id: string;
  evidence: string;
  parameter: string;
  section: string;
  lookFor: string;
  wouldRefute: string;
}

export const EVIDENCE_CHECKLIST: readonly EvidenceRow[] = [
  {
    id: 'mask-boundary',
    evidence: 'Where the bottom mask boundary actually sits',
    parameter: '`mask_lo`, `mask_hi`, and whether `bottommask 60,70` is latitude or colatitude',
    section: '§4.4, docs/AMENDMENTS.md A-02',
    lookFor:
      'The latitude at which projected content stops toward the bottom of the sphere, read off a graticule ' +
      'if one is showing. §4.4 reads 60 and 70 as absolute LATITUDE and marks the reading "ASSUME — verify". ' +
      'That inferred unit governs the domain of §7’s only gate with no tolerance.',
    wouldRefute:
      'A boundary near latitude −30° rather than −60° would mean the values are COLATITUDE, the protected ' +
      'region is roughly three times larger, and the hard unlit gate has been applied to the wrong region all ' +
      'along. A-02 asks for §8 item 15 to photograph the polar region with a latitude-labelled test pattern so ' +
      'this is read rather than inferred.',
  },
  {
    id: 'seam-colour',
    evidence:
      'Visible seam structure — is it a bright band, a dark band, or a <strong>coloured</strong> one?',
    parameter: '`γ_R,G,B` divergence — the rev 2 central claim',
    section: '§3.2',
    lookFor:
      'A flat or slowly varying region of content crossing a seam. §3.2 works the arithmetic: two projectors ' +
      'each asked for 0.5 linear encode 0.730; a blue channel at γ = 2.4 emits 0.469 apiece against 0.500, a ' +
      '6% blue deficit that reads as a YELLOW band. The just-noticeable threshold for a luminance step is 1–2% ' +
      'and the eye is more sensitive to a chromatic edge than to a luminance one.',
    wouldRefute:
      'A seam that is purely brighter or purely darker with no hue shift is evidence for a gain mismatch or a ' +
      'blend-width error rather than for per-channel gamma divergence. Either finding is worth an amendment; ' +
      'the second would demote §10’s highest-ranked photometric risk.',
  },
  {
    id: 'seam-shape',
    evidence: 'Whether the seam is a STEP or a BAND',
    parameter: 'what §7’s seam gates actually certify',
    section: 'docs/AMENDMENTS.md A-15',
    lookFor:
      'The spatial extent of the artifact. At the equator the two-projector overlap spans about 71° of ' +
      'longitude, and a per-channel gamma divergence produces a deficit that rises smoothly from zero at one ' +
      'edge to a maximum in the middle and back — there is no discontinuity anywhere in it. §7 gates a ' +
      'DISCONTINUITY; §3.2’s artifact is a BAND.',
    wouldRefute:
      'A photograph showing a wide soft band rather than a sharp step would confirm A-15 and support splitting ' +
      'the seam gates in two. A sharp step would support the gates as written and point at misregistration or ' +
      'a hard mask edge instead.',
  },
  {
    id: 'ambient',
    evidence: 'Overall ambient wash, and contrast in dark content',
    parameter: '`E_amb`, `E_amb_chroma`',
    section: '§5',
    lookFor:
      'How dark the darkest part of the sphere is against the room, and what COLOUR the wash is. §5 puts ' +
      '`E_amb` at 0.04 with a plausible range of 0.01–0.15 — a factor of fifteen — and its colour temperature ' +
      'at 4000 K because exhibit lighting is rarely daylight-balanced. §10 ranks the pair third of four.',
    wouldRefute:
      'Weakly. A photograph’s exposure, white balance and JPEG processing all sit between the sphere and the ' +
      'pixel, so this can suggest a range but cannot measure one. It is a reason to put a lux meter on §8’s ' +
      'checklist, which item 16 already does.',
  },
  {
    id: 'polar-shape',
    evidence: 'Whether the unlit polar region reads as scalloped or circular',
    parameter: 'confirms or refutes the four-lobed coverage boundary',
    section: '§4.3, docs/AMENDMENTS.md A-05',
    lookFor:
      'The top of the sphere, if the mount does not hide it, or the bottom with the mask off. §4.3 says ' +
      'coverage reaches latitude 80.4° along a projector’s own meridian but only 76.3° in the seam directions, ' +
      'so the unlit region is a FOUR-LOBED scalloped shape dipping lowest between projectors — not a circular cap.',
    wouldRefute:
      'A circular cap would mean the coverage model is wrong in a way `packages/sim` reproduces exactly to four ' +
      'decimal places, which would be a much bigger finding than a constant. Note that §1’s 6° suspension ' +
      'occlusion may hide the north cap entirely, in which case the photograph answers nothing.',
  },
  {
    id: 'multiplicity',
    evidence: 'Visible overlap multiplicity in bright flat content',
    parameter: '§4.2’s claim that N never exceeds 2',
    section: '§4.2',
    lookFor:
      'Count distinguishable brightness levels in a flat white field. §4.2 corrects rev 1 of the spec: three-way ' +
      'overlap would need a point within 80.4° of three equatorial directions 90° apart, and any three of the ' +
      'four contain an antipodal pair. The margin is 160.8° against 180° — nineteen degrees, which survives §2’s ' +
      'mount tolerance and the whole `d_proj` prior.',
    wouldRefute:
      'A visible third level would mean the rig is not built the way §2 describes, or that the arithmetic is ' +
      'wrong. Either is a finding worth an amendment; neither is a constant to nudge.',
  },
];

export function renderValidationPage(input: ValidationInput): string {
  const shown = input.photos.filter((p) => p.href !== null);
  const unverified = shown.filter((p) => p.provenance === 'unknown');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>sphere-sim — validation against photographs</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Validation — real photographs beside our render</h1>
  <div class="banner scope">
    <strong>Not part of the optimization loop. Not read by any critic.</strong>
    Nothing on this page feeds a metric, a gate, a score or <code>bench-results.json</code>. Its only job is
    plausibility: if our render looks nothing like a real sphere, the model is broken no matter how good the
    numbers look. Findings become <strong>proposed amendments in <code>docs/AMENDMENTS.md</code></strong> —
    never a silent change to a constant.
  </div>
  <p class="muted small">Generated ${esc(input.generatedAt)} · ${esc(VALIDATION_SCHEMA)} ·
    <code>node packages/bench/src/validation.ts</code></p>
</header>
<main>

<section id="provenance">
  <h2>Provenance</h2>
  <div class="banner rule">
    <strong>Images are never fetched.</strong> Nothing in this generator opens a socket. There is no download,
    no scrape, no URL. The project owner drops files into <code>validation/photos/</code> and adds a row to
    <code>validation/sources.json</code>; the generator reads that directory and nothing else.
    NOAA imagery is generally public domain, but <strong>photographs submitted to NOAA by individual SOS sites
    may not be</strong>, so provenance is <code>unknown</code> until the owner says otherwise.
  </div>
  <p class="small">Photographs are <strong>referenced by relative path, not inlined</strong>. Inlining an image
    whose provenance is unverified would copy it into a generated file that may be committed, attached or
    published — which is exactly the redistribution the banner below warns against. Our own renders are inlined,
    because they are ours. The page still makes no external request of any kind.</p>
  ${input.sourcesError === null ? '' : `<div class="banner bad"><strong>sources.json</strong> — ${esc(input.sourcesError)}</div>`}
  ${
    input.sources.note
      ? `<p class="small muted">From <code>sources.json</code>: ${esc(input.sources.note)}</p>`
      : ''
  }
</section>

<section id="photos">
  <h2>Photographs <span class="tag">${shown.length} supplied</span></h2>
  ${
    shown.length === 0
      ? emptyState(input)
      : `${
          unverified.length > 0
            ? `<div class="banner unverified"><strong>${unverified.length} of ${shown.length} images have
                 unverified provenance.</strong> Each is marked below. Do not redistribute them.</div>`
            : ''
        }${shown.map(photoCard).join('')}`
  }
  ${problemList(input)}
</section>

<section id="ours">
  <h2>Our render of the nominal rig</h2>
  <p class="lede">Rendered by <code>packages/sim</code> from the PARAMETERS.md nominals with the full shading
    model — four projectors at 5.18 m, cosine blend, <code>bottommask 60,70</code> read as latitude, ambient
    0.04 at 4000 K. <strong>Every constant behind how these look is class ASSUME</strong> (PARAMETERS.md §10),
    so a disagreement with a photograph is information about our assumptions, not proof that the photograph is
    unusual.</p>
  <div class="grid">
    ${input.reference.map(referenceCard).join('')}
  </div>
</section>

<section id="checklist">
  <h2>Evidence checklist</h2>
  <p class="lede">From <code>validation/README.md</code>. Each row names a parameter PARAMETERS.md says nobody
    has measured, what to look for in a photograph, and what a contrary observation would mean.
    <strong>A photograph is weak evidence</strong> — exposure, white balance, JPEG processing and the
    photographer's screen all sit between the sphere and the pixel — so a finding here is a reason to put
    something on the §8 measurement checklist, not a reason to edit a nominal.</p>
  ${EVIDENCE_CHECKLIST.map(evidenceCard).join('')}
</section>

<section id="howto">
  <h2>How to add photographs</h2>
  <ol class="small">
    <li>Drop image files into <code>validation/photos/</code>.</li>
    <li>Add an entry to <code>validation/sources.json</code>:
      <pre>{
  "file": "sos-gsfc-2019.jpg",
  "provenance": "unknown",
  "credit": "",
  "site": "",
  "dataset": "",
  "notes": "supplied by owner, source not yet confirmed"
}</pre>
      <code>provenance</code> is one of ${PROVENANCE_VALUES.map((p) => `<code>${p}</code>`).join(', ')}.
      Anything else is read as <code>unknown</code>, because a typo must not be able to upgrade a licence.</li>
    <li>If you know which SOS dataset was on the sphere, put its name in <code>dataset</code> and place a
      matching equirectangular source in <code>validation/datasets/</code>. The page then renders our
      simulation of the same dataset beside the photograph. <strong>PNG only</strong> — this project has zero
      runtime dependencies, so JPEG cannot be decoded; convert first. Without a matching dataset the photo
      still appears, just without a pair.</li>
    <li>Run <code>node packages/bench/src/validation.ts</code> to regenerate this page.</li>
  </ol>
</section>

<footer>
  <p class="small muted">Findings from this page are written up as <strong>proposed amendments</strong> in
    <code>docs/AMENDMENTS.md</code> with status <code>OPEN</code>, and PARAMETERS.md is never edited by us.
    A constant is never silently changed.</p>
  <p class="small muted">Science On a Sphere® is a registered trademark of NOAA. This describes an independent
    simulator and is not a NOAA product.</p>
</footer>
</main>
</body>
</html>
`;
}

function emptyState(input: ValidationInput): string {
  return `<div class="empty">
    <p class="big">No photographs have been supplied yet.</p>
    <p><code>validation/photos/</code> contains ${input.unlisted.length === 0 ? 'no image files' : `${input.unlisted.length} file(s) with no row in sources.json`},
      and <code>validation/sources.json</code> lists ${input.sources.images.length} image(s).</p>
    <p class="small">This is the expected state. Images are <strong>not scraped</strong>: the project owner
      supplies them, and until then this page has nothing to compare against. The renders below are still
      worth looking at on their own — they are what our model says a sphere looks like, and a reader who has
      stood next to one can say whether that is plausible without any photograph at all.</p>
  </div>`;
}

function photoCard(p: PhotoRecord): string {
  const unknown = p.provenance === 'unknown';
  return `<article class="photo${unknown ? ' unverified' : ''}">
    <h3>${esc(p.entry.file)}</h3>
    ${
      unknown
        ? `<div class="banner unverified"><strong>PROVENANCE UNVERIFIED — NOT FOR REDISTRIBUTION.</strong>
             ${p.provenanceMalformed ? `The row says <code>${esc(String(p.entry.provenance))}</code>, which is not one of the four allowed values, so it is read as <code>unknown</code>. ` : ''}
             NOAA imagery is generally public domain, but photographs submitted to NOAA by individual SOS sites
             may not be. Treat as unverified until the owner confirms.</div>`
        : ''
    }
    <table class="kv">
      <tr><th>provenance</th><td><code>${esc(p.provenance)}</code></td></tr>
      ${p.entry.credit ? `<tr><th>credit</th><td>${esc(p.entry.credit)}</td></tr>` : ''}
      ${p.entry.site ? `<tr><th>site</th><td>${esc(p.entry.site)}</td></tr>` : ''}
      ${p.entry.dataset ? `<tr><th>dataset</th><td>${esc(p.entry.dataset)}</td></tr>` : ''}
      ${p.entry.notes ? `<tr><th>notes</th><td>${esc(p.entry.notes)}</td></tr>` : ''}
    </table>
    <div class="pair">
      <figure>
        <img src="${esc(p.href ?? '')}" alt="photograph ${esc(p.entry.file)}" loading="lazy"/>
        <figcaption>Photograph, as supplied. Referenced from <code>validation/photos/</code>, not copied
          into this file.</figcaption>
      </figure>
      <figure>
        ${
          p.pairRender
            ? `<img src="${p.pairRender}" alt="our render of ${esc(p.entry.dataset ?? '')}"/>
               <figcaption>Our render of the same dataset, nominal rig, adult viewer. The dataset PNG was read
                 as gamma-2.2 encoded — an assumption about someone else's file.</figcaption>`
            : `<div class="nopair">No paired render.<br/><span class="small">${esc(p.pairReason)}</span></div>`
        }
      </figure>
    </div>
  </article>`;
}

function referenceCard(r: ReferenceRender): string {
  return `<figure class="ref">
    <img src="${r.dataUri}" alt="${esc(r.title)}"/>
    <figcaption><strong>${esc(r.title)}</strong><span>${r.lookFor}</span></figcaption>
  </figure>`;
}

function evidenceCard(row: EvidenceRow): string {
  return `<div class="ev">
    <h3>${row.evidence}</h3>
    <p class="evmeta">bears on ${row.parameter} · <span class="sec">${esc(row.section)}</span></p>
    <p><strong>Look for.</strong> ${row.lookFor}</p>
    <p class="refute"><strong>What would refute us.</strong> ${row.wouldRefute}</p>
  </div>`;
}

function problemList(input: ValidationInput): string {
  const rows: string[] = [];
  for (const p of input.photos) {
    for (const problem of p.problems) rows.push(`<li><code>${esc(p.entry.file || '(no file)')}</code> — ${esc(problem)}</li>`);
  }
  for (const f of input.unlisted) {
    rows.push(
      `<li><code>${esc(f)}</code> — present in <code>validation/photos/</code> with no row in ` +
        `<code>sources.json</code>. <strong>Not rendered.</strong> Every image needs a row before the page ` +
        `will show it, so an image can never appear without its provenance beside it.</li>`,
    );
  }
  if (rows.length === 0) return '';
  return `<div class="banner bad"><strong>${rows.length} item(s) need attention</strong>
    <ul class="small">${rows.join('')}</ul></div>`;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --fg: #1a1a1a; --muted: #5c6470; --line: #d9dde3;
  --grid: #edf0f4; --accent: #2b5fd9; --pass: #1f7a3d; --fail: #b3261e; --warn: #9a6700;
  --unverified: #fff4d6; --unverified-line: #d9a800;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1b1e24; --fg: #e8eaed; --muted: #9aa3af; --line: #333944;
    --grid: #262b33; --accent: #7aa2ff; --pass: #4ec37a; --fail: #ff6b5e; --warn: #e0a83c;
    --unverified: #2e2712; --unverified-line: #b98f00;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main, header, footer { max-width: 1100px; margin: 0 auto; padding: 0 22px; }
header { padding-top: 30px; }
h1 { font-size: 26px; margin: 0 0 14px; letter-spacing: -0.01em; }
h2 { font-size: 20px; margin: 0 0 10px; padding-bottom: 8px; border-bottom: 2px solid var(--line); }
h3 { font-size: 15px; margin: 16px 0 6px; }
section { margin: 40px 0; }
p { margin: 8px 0; }
.lede { max-width: 78ch; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.big { font-size: 17px; font-weight: 600; }
.tag { font-size: 12px; font-weight: 400; color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em;
  background: var(--grid); padding: 1px 4px; border-radius: 3px; }
pre { background: var(--grid); padding: 12px 14px; border-radius: 6px; overflow-x: auto; font-size: 12.5px; }
.banner { border-radius: 6px; padding: 10px 14px; margin: 12px 0; font-size: 13.5px; border: 1px solid var(--line); }
.banner.scope { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.banner.rule { border-color: var(--pass); background: color-mix(in srgb, var(--pass) 8%, transparent); }
.banner.bad { border-color: var(--fail); background: color-mix(in srgb, var(--fail) 10%, transparent); }
.banner.unverified { border-color: var(--unverified-line); background: var(--unverified); color: var(--warn); }
.banner ul { margin: 6px 0 0; padding-left: 20px; }
.empty { border: 1px dashed var(--line); border-radius: 8px; padding: 18px 20px; background: var(--panel); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
figure img { display: block; width: 100%; height: auto; border-radius: 4px; background: #000; }
figcaption { font-size: 12px; color: var(--muted); margin-top: 8px; }
figcaption strong { display: block; color: var(--fg); font-size: 13px; margin-bottom: 4px; }
figcaption span { display: block; margin-top: 4px; }
.photo { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 16px 0; background: var(--panel); }
.photo.unverified { border-color: var(--unverified-line); }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-top: 12px; }
.nopair { border: 1px dashed var(--line); border-radius: 4px; padding: 22px 14px; color: var(--muted);
  text-align: center; font-size: 13px; }
table.kv { border-collapse: collapse; font-size: 13px; margin: 6px 0; }
table.kv th { text-align: left; font-weight: 500; color: var(--muted); padding: 2px 14px 2px 0; vertical-align: top; }
table.kv td { padding: 2px 0; }
.ev { border-left: 3px solid var(--accent); padding: 2px 0 2px 14px; margin: 20px 0; }
.ev h3 { margin: 0 0 2px; }
.evmeta { font-size: 12.5px; color: var(--muted); margin: 0 0 8px; }
.evmeta .sec { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.refute { color: var(--muted); }
footer { margin: 50px 0 40px; padding-top: 16px; border-top: 1px solid var(--line); }
`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): number {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : path.join(VALIDATION_DIR, 'index.html');
  const input = collectValidationInput();
  const html = renderValidationPage(input);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);

  const shown = input.photos.filter((p) => p.href !== null).length;
  const unknown = input.photos.filter((p) => p.href !== null && p.provenance === 'unknown').length;
  process.stdout.write(
    `${path.relative(REPO_ROOT, out)} — ${shown} photograph(s), ${unknown} with unverified provenance, ` +
      `${input.reference.length} reference render(s), ${input.unlisted.length} unlisted file(s)\n`,
  );
  if (shown === 0) {
    process.stdout.write(
      `  no photographs supplied yet. That is the expected state: images are NOT scraped, the owner ` +
        `supplies them. See validation/README.md.\n`,
    );
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
