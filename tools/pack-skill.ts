// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * pack-skill — build an installable .skill archive from a skill directory.
 *
 * A .skill file is an ordinary ZIP; the name is what makes Claude offer to
 * install it. This writes one directly rather than shelling out to `zip`, for
 * the same reason the rest of the repo has no runtime dependencies: the build
 * should work on any machine with Node and nothing else.
 *
 * The archive is DETERMINISTIC — fixed timestamps, sorted entries, fixed
 * compression level. Repacking an unchanged skill produces a byte-identical
 * file, so `sha256sum` answers "did the skill actually change?" without
 * unpacking it. A packer that stamped the current time would make every build
 * look like a change, which is exactly the noise that makes people stop
 * checking.
 *
 * Run: node tools/pack-skill.ts skills/usage-report [out-dir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00:00, the earliest the DOS time format can express. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

function walk(dir: string, base: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    // Skip editor and OS debris rather than shipping it to every installer.
    else if (!/^\.(DS_Store|gitignore)$|~$/.test(entry.name)) out.push(path.relative(base, full));
  }
  return out;
}

export function packSkill(skillDir: string, outDir: string): string {
  const resolved = path.resolve(skillDir);
  const name = path.basename(resolved);
  const manifest = path.join(resolved, 'SKILL.md');
  if (!fs.existsSync(manifest)) throw new Error(`${resolved} has no SKILL.md — not a skill directory`);

  const parent = path.dirname(resolved);
  const files = walk(resolved, parent).sort();

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const rel of files) {
    const nameBytes = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
    const raw = fs.readFileSync(path.join(parent, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Only accept compression when it actually helps; otherwise store, so tiny
    // files do not grow.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    // >>> 0 is load-bearing: JS bitwise operators are 32-bit SIGNED, so
  // 0o100644 << 16 overflows to a negative number and writeUInt32LE rejects it.
  entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs (unix 0644)
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += header.length + nameBytes.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${name}.skill`);
  fs.writeFileSync(outPath, Buffer.concat([...local, centralBuf, end]));
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: node tools/pack-skill.ts <skill-dir> [out-dir]');
    process.exit(1);
  }
  const out = packSkill(dir, process.argv[3] ?? 'dist');
  const bytes = fs.statSync(out).size;
  console.log(`pack-skill: ${out} (${bytes.toLocaleString('en-US')} bytes)`);
}
