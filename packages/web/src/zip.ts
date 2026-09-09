// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A store-only ZIP writer, so a rig's files leave the page as one download.
 *
 * ## Why this exists rather than nine `a.click()` calls
 *
 * `downloadText` hands the browser one blob per file. A four-projector rig has
 * four warp meshes, four SOS alignment files and a config: browsers prompt on
 * the second and quietly drop later ones, so "save everything" was a button
 * that half worked and gave no sign which half.
 *
 * ## Store-only, and no dependency
 *
 * Method 0 — the bytes go in as they are. These are small text files; deflate
 * would save a few kilobytes and cost a compressor. The page loads no runtime
 * dependency by design, and a ZIP container is a header, a central directory
 * and a CRC, which is less code than wiring one in would be.
 *
 * ## Deterministic, which is what makes it testable
 *
 * Every entry carries the DOS epoch (1980-01-01 00:00) rather than the clock,
 * so the same files produce the same bytes and a test can say so. A timestamp
 * would make the archive unreproducible for the sake of a date nobody reads —
 * this repository byte-compares its outputs everywhere else and this is the
 * same argument applied to an archive.
 *
 * The one cost is that extracted files date to 1980. That is visible and
 * harmless; a wrong-looking date is better than an archive that cannot be
 * checked.
 */

/** One file in the archive. `name` may contain `/` to make directories. */
export interface ZipEntry {
  name: string;
  text: string;
}

/**
 * CRC-32, the ordinary reflected polynomial ZIP uses.
 *
 * Table built once on first use rather than at module load: the page imports
 * this module whether or not anybody ever presses the button.
 */
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE !== null) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Little-endian writers, because every field in the format is little-endian. */
function u16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}
function u32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/**
 * The DOS timestamp every entry carries. See the note on determinism above.
 *
 * 1980-01-01 00:00:00 is the epoch the format's 16-bit date field counts from,
 * so this is the smallest legal value rather than an arbitrary one.
 */
const DOS_DATE = (1 << 5) | 1; // year 0 (1980), month 1, day 1
const DOS_TIME = 0;

/**
 * Bit 11 of the general-purpose flags: the name is UTF-8.
 *
 * Set unconditionally. Every name here is ASCII today, where the flag is a
 * no-op, and a projector id that one day is not stays readable instead of
 * arriving mojibaked in whatever code page the extractor guesses.
 */
const FLAG_UTF8 = 0x800;

/**
 * Build a ZIP archive.
 *
 * Entries keep the order given: an extractor lists them in central-directory
 * order, so the README arrives first if it is passed first.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const body = enc.encode(entry.text);
    const sum = crc32(body);
    const offset = local.length;

    u32(local, SIG_LOCAL);
    u16(local, 20); // version needed to extract: 2.0
    u16(local, FLAG_UTF8);
    u16(local, 0); // method 0, stored
    u16(local, DOS_TIME);
    u16(local, DOS_DATE);
    u32(local, sum);
    u32(local, body.length); // compressed size == uncompressed, stored
    u32(local, body.length);
    u16(local, name.length);
    u16(local, 0); // no extra field
    for (const b of name) local.push(b);
    for (const b of body) local.push(b);

    u32(central, SIG_CENTRAL);
    u16(central, 20); // version made by
    u16(central, 20); // version needed
    u16(central, FLAG_UTF8);
    u16(central, 0);
    u16(central, DOS_TIME);
    u16(central, DOS_DATE);
    u32(central, sum);
    u32(central, body.length);
    u32(central, body.length);
    u16(central, name.length);
    u16(central, 0); // extra
    u16(central, 0); // comment
    u16(central, 0); // disk number
    u16(central, 0); // internal attributes
    u32(central, 0); // external attributes
    u32(central, offset); // where this entry's local header starts
    for (const b of name) central.push(b);
  }

  const end: number[] = [];
  u32(end, SIG_END);
  u16(end, 0); // this disk
  u16(end, 0); // disk the central directory starts on
  u16(end, entries.length);
  u16(end, entries.length);
  u32(end, central.length);
  u32(end, local.length); // central directory follows the last local entry
  u16(end, 0); // no archive comment

  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}
