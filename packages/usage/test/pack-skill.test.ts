/**
 * The skill packer.
 *
 * A .skill file is an ordinary ZIP, and the thing that makes it worth testing is
 * that nothing downstream will tell you it is malformed until somebody tries to
 * install it. There is no ZIP reader in the Node standard library, so this file
 * carries a small central-directory parser — the same tactic
 * packages/experiments/test/plot.test.ts uses for XML, and for the same reason.
 *
 * Determinism gets the most attention. Repacking an unchanged skill must produce
 * byte-identical output, because that is what lets `sha256sum` answer "did the
 * skill actually change?" without unpacking it. A packer that stamped the
 * current time would make every build look like a change, which is precisely
 * the noise that stops people checking.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { packSkill } from '../../../tools/pack-skill.ts';

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

/** Read the central directory: name -> decompressed bytes. */
function readZip(file: string): Map<string, Buffer> {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'bad central directory signature');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'bad local header signature');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compressed);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const SKILL = {
  'SKILL.md': '---\nname: demo\ndescription: A demo skill.\n---\n\n# Demo\n',
  'scripts/run.mjs': 'export const x = 1;\n'.repeat(60),
  'references/notes.md': '# Notes\n'.repeat(40),
};

test('the archive round-trips every file byte for byte', () => {
  const src = fixture(SKILL);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const name = path.basename(src);
  const entries = readZip(packSkill(src, out));

  assert.equal(entries.size, 3);
  for (const [rel, body] of Object.entries(SKILL)) {
    assert.equal(entries.get(`${name}/${rel}`)?.toString('utf8'), body, rel);
  }
});

test('repacking unchanged input is byte-identical', () => {
  // The whole point: sha256sum answers "did this change?" without unpacking.
  const src = fixture(SKILL);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const first = fs.readFileSync(packSkill(src, out));
  const second = fs.readFileSync(packSkill(src, out));
  assert.ok(first.equals(second));
});

test('a content change changes the bytes', () => {
  const src = fixture(SKILL);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const before = fs.readFileSync(packSkill(src, out));
  fs.writeFileSync(path.join(src, 'references/notes.md'), '# Different\n');
  const after = fs.readFileSync(packSkill(src, out));
  assert.ok(!before.equals(after), 'determinism must not mean insensitivity');
});

test('entries are sorted, so directory read order cannot leak in', () => {
  const src = fixture(SKILL);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const names = [...readZip(packSkill(src, out)).keys()];
  assert.deepEqual(names, [...names].sort());
});

test('external attributes do not overflow to a negative int', () => {
  // Regression: 0o100644 << 16 is negative in JS, because bitwise operators are
  // 32-bit SIGNED. writeUInt32LE rejected it and the packer threw outright.
  const src = fixture(SKILL);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const file = packSkill(src, out);
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const attrs = buf.readUInt32LE(buf.readUInt32LE(eocd + 16) + 38);
  assert.equal(attrs >>> 16, 0o100644);
});

test('editor and OS debris is not shipped to installers', () => {
  const src = fixture({ ...SKILL, '.DS_Store': 'junk', 'scripts/run.mjs~': 'backup' });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const names = [...readZip(packSkill(src, out)).keys()];
  assert.ok(!names.some((n) => n.endsWith('.DS_Store') || n.endsWith('~')), names.join(', '));
});

test('a directory without SKILL.md is refused', () => {
  // Packing one would produce an archive that installs and does nothing.
  const src = fixture({ 'scripts/run.mjs': 'export const x = 1;\n' });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  assert.throws(() => packSkill(src, out), /no SKILL\.md/);
});

test('incompressible content is stored rather than grown', () => {
  const random = Buffer.alloc(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) % 251;
  const src = fixture({ ...SKILL });
  fs.writeFileSync(path.join(src, 'assets.bin'), random);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const file = packSkill(src, out);
  assert.ok(readZip(file).get(`${path.basename(src)}/assets.bin`)?.equals(random));
});

test('the real skill packs and its manifest survives', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const skill = path.join(repo, 'skills', 'usage-report');
  if (!fs.existsSync(skill)) return; // packaged checkouts may omit it
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const entries = readZip(packSkill(skill, out));
  const manifest = entries.get('usage-report/SKILL.md')?.toString('utf8') ?? '';
  assert.match(manifest, /^---\nname: usage-report\n/);
  assert.ok(entries.has('usage-report/scripts/run.mjs'));
});
