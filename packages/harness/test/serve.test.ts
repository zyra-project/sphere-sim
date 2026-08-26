// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The static server.
 *
 * `resolveRequest` is pure so the interesting cases can be driven without a
 * socket. The interesting cases are the refusals: a path check nobody has
 * watched reject something is not a path check, and the traversal encodings that
 * actually get used in the wild (`%2e%2e`, a doubled slash, a NUL) are exactly
 * the ones a string-level `includes('..')` test misses.
 *
 * The page itself is also checked for the two things it cannot be allowed to
 * lose: the module script that boots the harness, and the honesty furniture —
 * the ASSUME marking and the PROVISIONAL marking — which the whole harness
 * exists to keep in front of a human.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentTypeOf, resolveRequest } from '../serve.ts';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HARNESS, '..', '..');

test('the root serves the harness page', () => {
  const r = resolveRequest('/', HARNESS, REPO);
  assert.equal(r.status, 200);
  assert.equal(r.file, path.join(HARNESS, 'index.html'));
});

test('a query string and a fragment are stripped before resolution', () => {
  assert.equal(resolveRequest('/index.html?v=2', HARNESS, REPO).status, 200);
  assert.equal(resolveRequest('/index.html#top', HARNESS, REPO).status, 200);
});

test('the repository is readable under /repo/, and only there', () => {
  const doc = resolveRequest('/repo/docs/PARAMETERS.md', HARNESS, REPO);
  assert.equal(doc.status, 200);
  assert.equal(doc.file, path.join(REPO, 'docs', 'PARAMETERS.md'));
  // Without the prefix the same path is resolved under the harness directory and
  // is simply absent.
  assert.equal(resolveRequest('/docs/PARAMETERS.md', HARNESS, REPO).status, 404);
});

test('traversal is refused, in every encoding that reaches the resolver', () => {
  const attempts = [
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/repo/../../../etc/passwd',
    '//etc/passwd',
    '/./../../package.json',
  ];
  for (const attempt of attempts) {
    const r = resolveRequest(attempt, HARNESS, REPO);
    assert.notEqual(r.status, 200, `${attempt} was served as ${r.file}`);
    if (r.file !== null) {
      assert.ok(
        r.file.startsWith(HARNESS + path.sep) || r.file.startsWith(REPO + path.sep),
        `${attempt} escaped to ${r.file}`,
      );
    }
  }
});

test('a symbolic link out of the served root is refused', () => {
  // The string check passes for both of these -- neither path contains '..' and
  // both resolve under the harness -- so this is the case `path.resolve` alone
  // cannot see. Built in a scratch root rather than in the repository, because a
  // committed symlink to /etc is a worse idea than the bug it would test.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-symlink-'));
  const root = path.join(scratch, 'root');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  // A link that stays inside is still served: the check must refuse the escape,
  // not every link.
  fs.writeFileSync(path.join(root, 'real.txt'), 'fine\n');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'inside.txt'));

  try {
    assert.equal(resolveRequest('/escape.txt', root, root).status, 403);
    assert.equal(resolveRequest('/escape/secret.txt', root, root).status, 403);
    assert.equal(resolveRequest('/inside.txt', root, root).status, 200);
    assert.equal(resolveRequest('/', root, root).status, 200);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a NUL byte and a broken percent-encoding are rejected', () => {
  assert.equal(resolveRequest('/index%00.html', HARNESS, REPO).status, 400);
  assert.equal(resolveRequest('/%zz', HARNESS, REPO).status, 400);
});

test('a directory without an index is not listed', () => {
  const r = resolveRequest('/src/', HARNESS, REPO);
  assert.equal(r.status, 403);
  assert.equal(r.file, null);
});

test('content types cover everything the page loads', () => {
  assert.equal(contentTypeOf('/x/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeOf('/x/main.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeOf('/x/main.js.map'), 'application/json; charset=utf-8');
  assert.equal(contentTypeOf('/x/PARAMETERS.md'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeOf('/x/unknown.bin'), 'application/octet-stream');
});

test('the page boots the bundle the web build actually emits', () => {
  const html = fs.readFileSync(path.join(HARNESS, 'index.html'), 'utf8');
  const script = /<script type="module" src="([^"]+)"><\/script>/.exec(html);
  assert.ok(script, 'the page has no module script');
  const src = script[1];
  assert.ok(src.startsWith('./'), 'the bundle is not referenced relatively');
  // `tsconfig.web.json` has rootDir `packages` and outDir `packages/harness/dist`,
  // so `packages/harness/web/main.ts` emits to `dist/harness/web/main.js`. If
  // either moves, this is the test that says so instead of a blank canvas.
  assert.equal(src, './dist/harness/web/main.js');
});

test('the page reaches for nothing outside itself', () => {
  const html = fs.readFileSync(path.join(HARNESS, 'index.html'), 'utf8');
  assert.equal(/https?:\/\//i.test(html), false, 'an absolute URL reached the page');
  assert.equal(/@import/i.test(html), false);
  for (const m of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
    assert.ok(m[1].startsWith('./') || m[1].startsWith('#'), `non-local reference: ${m[1]}`);
  }
});

test('the page keeps the honesty furniture the harness exists for', () => {
  const html = fs.readFileSync(path.join(HARNESS, 'index.html'), 'utf8');
  // ASSUME controls must be visually distinct — a class alone is not enough, the
  // stylesheet has to do something with it.
  assert.ok(/\.ctl\.assume\s*\{[^}]*border/.test(html), 'ASSUME controls are not visually marked');
  assert.ok(/\.k-assume\s*\{/.test(html), 'the ASSUME class pill has no style');
  assert.ok(/\.pill\.provisional\s*\{/.test(html), 'the PROVISIONAL pill has no style');
  assert.ok(/\.provbanner\s*\{/.test(html), 'the provisional banner has no style');
  // The parity block must have a failure appearance, or a disagreement would be
  // as quiet as agreement.
  assert.ok(/\.parity\.fail\s*\{/.test(html), 'a failing parity check is not styled differently');
  // Light and dark.
  assert.ok(/prefers-color-scheme:\s*dark/.test(html), 'the page has no dark scheme');
  // And the header says what the parity number is, up front.
  assert.ok(/parity/i.test(html));
  assert.ok(/PROVISIONAL/.test(html));
  assert.ok(/§3\.4/.test(html), 'the page does not name the framebuffer topology it is showing');
});
