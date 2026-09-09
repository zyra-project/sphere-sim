// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The archive is a real ZIP, not merely self-consistent.
 *
 * A writer checked by its own reader agrees with itself about a format it may
 * have misunderstood, which is the failure `readPackedField` sits beside its
 * writer to avoid and the same one applies here. Two things stand in for an
 * independent implementation:
 *
 *   1. **CRC-32 against the published check values.** `crc32("123456789")` is
 *      `0xcbf43926` in every specification that names one. That pins the
 *      polynomial and the reflection against the standard rather than against
 *      this file.
 *   2. **A reader that starts from the CENTRAL DIRECTORY**, the way an
 *      extractor does — walking back from the end-of-central-directory record
 *      to each entry's local header by its recorded offset. A reader that
 *      instead walked the local headers forward would agree with the writer
 *      about entry order and offsets even if both were wrong.
 *
 * Checked once against an outside implementation as well: Python's `zipfile`
 * opened an archive from `buildZip`, `testzip()` returned `None` (every CRC
 * verified), and all seven entries — including an empty file and a non-ASCII
 * name — round-tripped.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildZip, crc32 } from '../src/zip.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16At(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}
function u32At(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

/** Read an archive the way an extractor does: end record, directory, entries. */
function readZip(zip: Uint8Array): { name: string; text: string; crc: number }[] {
  // The end record is the last 22 bytes when there is no archive comment, and
  // this writer never writes one — asserted rather than searched backwards for,
  // because a comment appearing would be a change this test should notice.
  const end = zip.length - 22;
  assert.equal(u32At(zip, end), 0x06054b50, 'no end-of-central-directory record where expected');
  const count = u16At(zip, end + 10);
  const cdSize = u32At(zip, end + 12);
  const cdOffset = u32At(zip, end + 16);
  assert.equal(cdOffset + cdSize, end, 'the central directory does not end where the record does');

  const out: { name: string; text: string; crc: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(u32At(zip, p), 0x02014b50, `entry ${i} has no central header`);
    const crc = u32At(zip, p + 16);
    const size = u32At(zip, p + 24);
    const nameLen = u16At(zip, p + 28);
    const localAt = u32At(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen;

    // Follow the recorded offset to the local header, as an extractor does.
    assert.equal(u32At(zip, localAt), 0x04034b50, `${name}: no local header at its offset`);
    const lNameLen = u16At(zip, localAt + 26);
    const lExtraLen = u16At(zip, localAt + 28);
    const body = localAt + 30 + lNameLen + lExtraLen;
    out.push({ name, text: dec.decode(zip.subarray(body, body + size)), crc });
  }
  return out;
}

test('crc32 matches the published check values', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('')), 0);
  assert.equal(crc32(enc.encode('a')), 0xe8b7be43);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('every entry comes back through the central directory', () => {
  const entries = [
    { name: 'README.txt', text: 'what each file is\nsecond line\n' },
    { name: 'warp/P1.data', text: '2\n3 3\n0 0 0.5 0.5 1\n' },
    { name: 'alignment/P1.alignment', text: 'translate 0 0\n' },
    { name: 'local_sos_config.json', text: '{\n  "radius": 0.8128\n}\n' },
    // An empty file is where a length-driven reader goes wrong, and a rig can
    // legitimately produce one — a projector switched off writes no mesh.
    { name: 'empty.txt', text: '' },
    // Non-ASCII exercises the UTF-8 flag: the byte length and the character
    // count differ, and a writer using the wrong one truncates the name.
    { name: 'unicode-é.txt', text: 'non-ascii name\n' },
  ];
  const got = readZip(buildZip(entries));
  assert.equal(got.length, entries.length);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(got[i].name, entries[i].name, `entry ${i} name`);
    assert.equal(got[i].text, entries[i].text, `entry ${i} body`);
    assert.equal(got[i].crc, crc32(enc.encode(entries[i].text)), `entry ${i} crc`);
  }
});

test('the same files produce the same bytes', () => {
  // No clock in the archive — see the note on determinism in `zip.ts`. Without
  // it this could not be byte-compared at all, which is most of why it is so.
  const files = [
    { name: 'a.txt', text: 'one' },
    { name: 'b/c.txt', text: 'two' },
  ];
  assert.deepEqual(buildZip(files), buildZip(files));

  // And the bytes actually depend on the content, or the check above passes for
  // an archive that ignores its input.
  assert.notDeepEqual(buildZip(files), buildZip([{ name: 'a.txt', text: 'one!' }, files[1]]));
  assert.notDeepEqual(buildZip(files), buildZip([{ name: 'a.txt!', text: 'one' }, files[1]]));
});

test('an archive with no entries is still a readable archive', () => {
  // Reachable: a rig with every projector switched off exports nothing. An
  // empty archive is a better answer than a zero-byte file the extractor
  // rejects, and this is the smallest legal one.
  const zip = buildZip([]);
  assert.equal(zip.length, 22);
  assert.deepEqual(readZip(zip), []);
});
