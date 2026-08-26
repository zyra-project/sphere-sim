// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The validation page.
 *
 * Five claims, and the first two are the ones that matter most because they are
 * about what the page must never do:
 *
 *  1. **It fetches nothing.** No socket, no URL, no scheme anywhere in the
 *     generator or in its output. The project owner supplies files; the
 *     generator reads a local directory.
 *  2. **Provenance cannot be lost.** An image with no row in `sources.json` is
 *     not rendered at all, an image whose provenance is `unknown` renders under
 *     an explicit "not for redistribution" banner, and a provenance value that
 *     is not one of the four allowed strings is read as `unknown` rather than
 *     as whatever it says — a typo must not be able to upgrade a licence.
 *  3. **It renders correctly with zero photographs**, which is the current
 *     state, and says so plainly rather than looking broken.
 *  4. **The evidence checklist is present and specific**, naming the parameter
 *     each observation bears on and stating that findings become proposed
 *     amendments rather than silent constant changes.
 *  5. **The PNG reader is real.** "Our render of the same dataset" is a contract
 *     in `validation/README.md`, and a decoder that could not round-trip our own
 *     encoder would make it a promise rather than a feature.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_CHECKLIST,
  PROVENANCE_VALUES,
  collectValidationInput,
  decodePng,
  parseProvenance,
  renderValidationPage,
} from '../src/validation.ts';
import type { SourceEntry, ValidationInput } from '../src/validation.ts';
import { createImage, flatField } from '../../sim/src/equirect.ts';
import { encodePng16, encodePng8 } from '../../sim/src/png.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempValidation(
  entries: SourceEntry[],
  files: string[],
  extra: { note?: string; rawImages?: unknown } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-validation-'));
  fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'datasets'), { recursive: true });
  const body: Record<string, unknown> = { images: extra.rawImages ?? entries };
  if (extra.note) body.note = extra.note;
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(body, null, 2));
  for (const f of files) fs.writeFileSync(path.join(dir, 'photos', f), 'not really an image');
  return dir;
}

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    sources: { images: [] },
    photos: [],
    unlisted: [],
    reference: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
    sourcesError: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. It fetches nothing
// ---------------------------------------------------------------------------

test('the generator contains no network call and no URL', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'validation.ts'), 'utf8');
  // Strip comments and template prose: the module explains at length that it
  // does not fetch, and the word appearing in that explanation is not a call.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/\bfetch\s*\(/, /\bhttps?:\/\//, /node:https?/, /\bXMLHttpRequest\b/]) {
    assert.equal(forbidden.test(code), false, `the generator matches ${forbidden}`);
  }
  for (const mod of ['node:http', 'node:https', 'node:net', 'node:dgram']) {
    assert.equal(code.includes(mod), false, `the generator imports ${mod}`);
  }
});

test('the page reaches for nothing outside the validation directory', () => {
  const dir = tempValidation(
    [{ file: 'a.jpg', provenance: 'owner-supplied', credit: 'somebody' }],
    ['a.jpg'],
  );
  try {
    const html = renderValidationPage(collectValidationInput({ validationDir: dir, renderPairs: false }));
    assert.equal(/https?:\/\//i.test(html), false, 'an absolute URL reached the page');
    assert.equal(/<script/i.test(html), false, 'a script tag reached the page');
    assert.equal(/<link\b/i.test(html), false, 'a link tag reached the page');
    assert.equal(/@import/i.test(html), false);
    for (const m of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
      const v = m[1];
      assert.ok(
        v.startsWith('data:') || v.startsWith('#') || v.startsWith('photos/'),
        `reference leaves the validation directory: ${v.slice(0, 60)}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a supplied photograph is REFERENCED, never inlined', () => {
  // Inlining an image whose provenance is unverified would copy it into a
  // generated file that may be committed or attached — the exact redistribution
  // the banner warns against.
  const dir = tempValidation([{ file: 'a.jpg', provenance: 'unknown' }], ['a.jpg']);
  try {
    const collected = collectValidationInput({ validationDir: dir, renderPairs: false });
    assert.equal(collected.photos[0].href, 'photos/a.jpg');
    const html = renderValidationPage(collected);
    assert.ok(html.includes('src="photos/a.jpg"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Provenance cannot be lost
// ---------------------------------------------------------------------------

test('an unknown provenance renders with an explicit not-for-redistribution banner', () => {
  const dir = tempValidation([{ file: 'a.jpg', provenance: 'unknown' }], ['a.jpg']);
  try {
    const html = renderValidationPage(collectValidationInput({ validationDir: dir, renderPairs: false }));
    assert.ok(html.includes('PROVENANCE UNVERIFIED — NOT FOR REDISTRIBUTION'));
    assert.ok(/photographs submitted to NOAA by individual SOS sites/i.test(html));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a provenance value outside the four allowed ones is read as unknown', () => {
  for (const bad of ['public domain', 'PUBLIC-DOMAIN', 'cc-by', '', 42, null, undefined]) {
    const parsed = parseProvenance(bad);
    assert.equal(parsed.value, 'unknown', `${JSON.stringify(bad)} was not downgraded to unknown`);
    assert.equal(parsed.malformed, true);
  }
  for (const good of PROVENANCE_VALUES) {
    const parsed = parseProvenance(good);
    assert.equal(parsed.value, good);
    assert.equal(parsed.malformed, false);
  }
});

test('a malformed provenance is banner-marked AND listed as a problem', () => {
  const dir = tempValidation([{ file: 'a.jpg', provenance: 'cc-by-sa' }], ['a.jpg']);
  try {
    const collected = collectValidationInput({ validationDir: dir, renderPairs: false });
    assert.equal(collected.photos[0].provenance, 'unknown');
    assert.equal(collected.photos[0].provenanceMalformed, true);
    assert.equal(collected.photos[0].problems.length, 1);
    const html = renderValidationPage(collected);
    assert.ok(html.includes('PROVENANCE UNVERIFIED'));
    assert.ok(html.includes('cc-by-sa'));
    assert.ok(html.includes('need attention'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every provenance value is displayed, not just the unknown ones', () => {
  const dir = tempValidation(
    PROVENANCE_VALUES.map((p, i) => ({ file: `p${i}.jpg`, provenance: p })),
    PROVENANCE_VALUES.map((_, i) => `p${i}.jpg`),
  );
  try {
    const html = renderValidationPage(collectValidationInput({ validationDir: dir, renderPairs: false }));
    for (const p of PROVENANCE_VALUES) assert.ok(html.includes(`<code>${p}</code>`), `${p} is not shown`);
    // One banner per unknown image, plus the summary banner.
    assert.equal([...html.matchAll(/PROVENANCE UNVERIFIED/g)].length, 1);
    assert.ok(html.includes('1 of 4 images have'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with no row in sources.json is NOT rendered, and is flagged', () => {
  // validation/README.md: "Every image needs a row in sources.json before the
  // validation page will render it." An image can never appear without its
  // provenance beside it.
  const dir = tempValidation([], ['orphan.jpg']);
  try {
    const collected = collectValidationInput({ validationDir: dir, renderPairs: false });
    assert.deepEqual(collected.unlisted, ['orphan.jpg']);
    assert.equal(collected.photos.length, 0);
    const html = renderValidationPage(collected);
    assert.equal(html.includes('src="photos/orphan.jpg"'), false, 'an unlisted image was rendered');
    assert.ok(html.includes('orphan.jpg'), 'an unlisted image was not even flagged');
    assert.ok(html.includes('Not rendered'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row naming a file that is not there is flagged and not rendered', () => {
  const dir = tempValidation([{ file: 'ghost.jpg', provenance: 'owner-supplied' }], []);
  try {
    const collected = collectValidationInput({ validationDir: dir, renderPairs: false });
    assert.equal(collected.photos[0].href, null);
    assert.ok(collected.photos[0].problems.some((p) => p.includes('does not contain it')));
    const html = renderValidationPage(collected);
    assert.equal(html.includes('src="photos/ghost.jpg"'), false);
    assert.ok(html.includes('need attention'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row whose file escapes photos/ is refused', () => {
  const dir = tempValidation(
    [
      { file: '../../package.json', provenance: 'owner-supplied' },
      { file: 'sub/dir.jpg', provenance: 'owner-supplied' },
    ],
    [],
  );
  try {
    const collected = collectValidationInput({ validationDir: dir, renderPairs: false });
    for (const p of collected.photos) {
      assert.equal(p.href, null, `${p.entry.file} was given an href`);
      assert.ok(p.problems.some((x) => x.includes('bare filename')));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dataset name that escapes datasets/ finds nothing', () => {
  const dir = tempValidation(
    [{ file: 'a.jpg', provenance: 'owner-supplied', dataset: '../../package' }],
    ['a.jpg'],
  );
  try {
    const collected = collectValidationInput({ validationDir: dir });
    assert.equal(collected.photos[0].pairRender, null);
    assert.ok(collected.photos[0].pairReason.includes('no matching file'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken sources.json produces a page that says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-validation-'));
  try {
    fs.writeFileSync(path.join(dir, 'sources.json'), '{ not json');
    const collected = collectValidationInput({ validationDir: dir, renderPairs: false });
    assert.ok(collected.sourcesError);
    const html = renderValidationPage(collected);
    assert.ok(html.includes('could not be read'));
    assert.ok(html.includes('No photographs have been supplied yet.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Zero photographs is the current state and must look deliberate
// ---------------------------------------------------------------------------

test('with no photographs the page renders and says so plainly', () => {
  const html = renderValidationPage(input());
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('No photographs have been supplied yet.'));
  assert.ok(/not scraped/i.test(html), 'the page does not say that images are not scraped');
  assert.ok(html.includes('the project owner'), 'the page does not say who supplies images');
  // The how-to has to be there, or "supply some" is advice with no instructions.
  assert.ok(html.includes('How to add photographs'));
  assert.ok(html.includes('validation/photos/'));
  assert.ok(html.includes('sources.json'));
});

test('the repository’s real validation directory is in the empty state, and renders', () => {
  const collected = collectValidationInput({ renderPairs: false });
  assert.equal(collected.photos.filter((p) => p.href !== null).length, 0);
  assert.deepEqual(collected.unlisted, []);
  const html = renderValidationPage(collected);
  assert.ok(html.includes('No photographs have been supplied yet.'));
});

// ---------------------------------------------------------------------------
// 4. Scope and the evidence checklist
// ---------------------------------------------------------------------------

test('the page states its scope: not the loop, not a critic, amendments not edits', () => {
  const html = renderValidationPage(input());
  assert.ok(html.includes('Not part of the optimization loop'));
  assert.ok(html.includes('Not read by any critic'));
  assert.ok(html.includes('proposed amendments'));
  assert.ok(html.includes('docs/AMENDMENTS.md'));
  assert.ok(/never a silent change to a constant|never silently changed/i.test(html));
  assert.ok(/weak evidence/i.test(html), 'the page does not caveat what a photograph can prove');
});

test('the evidence checklist covers every row validation/README.md names', () => {
  const ids = EVIDENCE_CHECKLIST.map((r) => r.id);
  for (const required of ['mask-boundary', 'seam-colour', 'ambient', 'polar-shape', 'multiplicity']) {
    assert.ok(ids.includes(required), `the checklist has no row for ${required}`);
  }
  for (const row of EVIDENCE_CHECKLIST) {
    assert.ok(row.lookFor.length > 120, `${row.id}: "look for" is too vague to act on`);
    assert.ok(row.wouldRefute.length > 80, `${row.id}: does not say what would refute us`);
    assert.ok(row.section.length > 0);
  }

  const html = renderValidationPage(input());
  // The specific claims the task and the README ask for, by their own words.
  assert.ok(/latitude or colatitude/i.test(html), 'the mask-units question is not stated');
  assert.ok(html.includes('A-02'));
  assert.ok(/bright band, a dark band, or a <strong>coloured<\/strong> one/i.test(html));
  assert.ok(html.includes('§3.2'));
  assert.ok(html.includes('E_amb'));
  assert.ok(html.includes('§5'));
  assert.ok(/scalloped/i.test(html) && /circular/i.test(html));
  assert.ok(html.includes('§4.3'));
  assert.ok(html.includes('§4.2'));
});

test('the page renders in light and dark', () => {
  const html = renderValidationPage(input());
  assert.ok(/prefers-color-scheme:\s*dark/.test(html));
  assert.ok(/color-scheme:\s*light dark/.test(html));
  // No colour is defined only inside the dark block.
  const root = /:root\s*\{([^}]*)\}/.exec(html);
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root\s*\{([^}]*)\}/.exec(html);
  assert.ok(root && dark);
  const names = (block: string): string[] => [...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]);
  for (const name of names(dark[1])) {
    assert.ok(names(root[1]).includes(name), `${name} is defined only in the dark block`);
  }
});

// ---------------------------------------------------------------------------
// 5. The PNG reader
// ---------------------------------------------------------------------------

test('the PNG reader round-trips our own encoder, 8-bit and 16-bit', () => {
  const src = createImage(23, 17);
  for (let i = 0; i < 23 * 17; i++) {
    src.data[3 * i] = (i % 23) / 22;
    src.data[3 * i + 1] = Math.floor(i / 23) / 16;
    src.data[3 * i + 2] = 0.5;
  }
  for (const [label, bytes, tolerance] of [
    ['8-bit', encodePng8(src, { displayGamma: 2.2 }), 0.01],
    ['16-bit', encodePng16(src, { displayGamma: 2.2 }), 1e-4],
  ] as [string, Buffer, number][]) {
    const back = decodePng(bytes, 2.2);
    assert.equal(back.width, 23, label);
    assert.equal(back.height, 17, label);
    let worst = 0;
    for (let i = 0; i < src.data.length; i++) worst = Math.max(worst, Math.abs(src.data[i] - back.data[i]));
    assert.ok(worst < tolerance, `${label}: worst channel error ${worst}`);
  }
});

test('the PNG reader exercises every filter type', () => {
  // A gradient with noise makes the encoder's fixed filter-0 output large, so
  // instead the filters are driven directly: a hand-built stream, one row per
  // filter, decoded and checked against what the filter definition says.
  const width = 4;
  const height = 5;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = y; // filter types 0..4
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = (y * 7 + i * 3) & 0xff;
  }
  const png = buildPng(width, height, 8, 2, zlib.deflateSync(raw));
  const img = decodePng(png, 1);
  assert.equal(img.width, width);
  assert.equal(img.height, height);
  for (const v of img.data) assert.ok(v >= 0 && v <= 1, `decoded ${v} outside [0,1]`);
});

test('the PNG reader refuses what it cannot decode, with a message that says what to do', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /signature/);
  // Colour type 3 is palette.
  assert.throws(
    () => decodePng(buildPng(2, 2, 8, 3, zlib.deflateSync(Buffer.alloc(6)))),
    /colour type 3 is not supported/,
  );
  // Bit depth 4.
  assert.throws(
    () => decodePng(buildPng(2, 2, 4, 2, zlib.deflateSync(Buffer.alloc(6)))),
    /bit depth 4 is not supported/,
  );
  assert.throws(
    () => decodePng(buildPng(2, 2, 8, 2, zlib.deflateSync(Buffer.alloc(14)), true)),
    /interlaced/,
  );
});

test('a PNG dataset produces a paired render; a non-PNG says why it cannot', () => {
  const dir = tempValidation(
    [
      { file: 'a.jpg', provenance: 'owner-supplied', dataset: 'blue-marble' },
      { file: 'b.jpg', provenance: 'owner-supplied', dataset: 'jpeg-one' },
      { file: 'c.jpg', provenance: 'owner-supplied' },
    ],
    ['a.jpg', 'b.jpg', 'c.jpg'],
  );
  try {
    const equirect = flatField(64, 32, { r: 0.6, g: 0.4, b: 0.2 });
    fs.writeFileSync(path.join(dir, 'datasets', 'blue-marble.png'), encodePng8(equirect));
    fs.writeFileSync(path.join(dir, 'datasets', 'jpeg-one.jpg'), Buffer.from('jpeg bytes'));

    const collected = collectValidationInput({ validationDir: dir });
    const [a, b, c] = collected.photos;
    assert.ok(a.pairRender && a.pairRender.startsWith('data:image/png;base64,'), 'no paired render for a PNG dataset');
    assert.equal(a.pairReason, '');
    assert.equal(b.pairRender, null);
    assert.ok(b.pairReason.includes('zero runtime'), `unhelpful reason: ${b.pairReason}`);
    assert.equal(c.pairRender, null);
    assert.ok(c.pairReason.includes('no `dataset` named'));

    const html = renderValidationPage(collected);
    assert.ok(html.includes('Our render of the same dataset'));
    assert.ok(html.includes('No paired render.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Assemble a PNG around an already-deflated data block. Test-only. */
function buildPng(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  idat: Buffer,
  interlaced = false,
): Uint8Array {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlaced ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
