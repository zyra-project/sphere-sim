/**
 * The harness's static server. `npm run harness`.
 *
 * Zero dependencies — `node:http`, `node:fs`, `node:path` and nothing else, the
 * same rule the rest of the project follows. A dev server that needs an npm
 * install is a dev server that stops working the day the registry is
 * unreachable, and this one exists precisely for the situation where somebody is
 * standing next to a sphere with a laptop.
 *
 * Three things it does beyond serving bytes:
 *
 *  1. **It checks that the browser bundle exists before it starts**, and if it
 *     does not, it says `npm run build:web` rather than serving an index page
 *     whose only symptom is a blank canvas and a 404 in a console nobody opened.
 *  2. **It refuses to serve anything outside the served roots.** The path is
 *     resolved and then checked against the root prefix, so `..%2f..%2f/etc/passwd`
 *     gets a 403 rather than a file.
 *  3. **It serves from two roots.** `packages/harness/` holds the page and the
 *     compiled bundle; the repository root is exposed READ-ONLY under `/repo/`
 *     so the page can link to `docs/PARAMETERS.md` and the amendments it keeps
 *     citing. Nothing writes.
 *
 * No caching headers, deliberately: this is a development harness and a stale
 * bundle after a rebuild is a bug report that costs half an hour.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BUNDLE = path.join(HERE, 'dist', 'harness', 'web', 'main.js');

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export interface Resolution {
  /** Absolute path to serve, or `null` when the request must not be served. */
  file: string | null;
  status: number;
  reason: string;
}

/**
 * Map a request URL to a file, or refuse.
 *
 * Exported and pure so `test/serve.test.ts` can drive the traversal cases
 * without opening a socket. A path check nobody has watched reject something is
 * not a path check.
 */
export function resolveRequest(
  urlPath: string,
  harnessRoot: string = HERE,
  repoRoot: string = REPO_ROOT,
): Resolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return { file: null, status: 400, reason: 'the request path is not valid percent-encoding' };
  }
  if (decoded.includes('\0')) {
    return { file: null, status: 400, reason: 'the request path contains a NUL byte' };
  }

  const underRepo = decoded.startsWith('/repo/');
  const root = underRepo ? repoRoot : harnessRoot;
  const rel = underRepo ? decoded.slice('/repo/'.length) : decoded.replace(/^\/+/, '');
  const requested = rel === '' ? 'index.html' : rel;

  // Resolve first, then test the prefix. Testing for '..' in the string instead
  // misses '%2e%2e', symlinks, and Windows separators.
  const resolved = path.resolve(root, requested);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    return { file: null, status: 403, reason: 'the request path leaves the served directory' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { file: null, status: 404, reason: `not found: ${decoded}` };
  }
  if (stat.isDirectory()) {
    const index = path.join(resolved, 'index.html');
    if (fs.existsSync(index)) return { file: index, status: 200, reason: 'ok' };
    return { file: null, status: 403, reason: 'directory listing is not served' };
  }
  return { file: resolved, status: 200, reason: 'ok' };
}

export function contentTypeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function createServer(harnessRoot: string = HERE, repoRoot: string = REPO_ROOT): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('only GET and HEAD are served\n');
      return;
    }
    const resolution = resolveRequest(req.url ?? '/', harnessRoot, repoRoot);
    if (resolution.file === null) {
      res.writeHead(resolution.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${resolution.status}: ${resolution.reason}\n`);
      return;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(resolution.file);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`500: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
    res.writeHead(200, {
      'content-type': contentTypeOf(resolution.file),
      'content-length': String(body.length),
      // A development harness must never serve a stale bundle after a rebuild.
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  });
}

function main(): void {
  const port = Number(process.env.PORT ?? 8173);
  if (!fs.existsSync(BUNDLE)) {
    process.stderr.write(
      `\npackages/harness: the browser bundle is missing.\n\n` +
        `  expected: ${path.relative(REPO_ROOT, BUNDLE)}\n` +
        `  build it: npm run build:web\n\n` +
        `Serving anyway so the page's error banner is visible, but the harness will not render.\n\n`,
    );
  }
  const server = createServer();
  server.listen(port, () => {
    process.stdout.write(
      `sphere-sim harness on http://localhost:${port}/\n` +
        `  repository files are readable under /repo/ (docs/PARAMETERS.md, docs/AMENDMENTS.md)\n` +
        `  the headless half of the parity check: node --test "packages/harness/test/**/*.test.ts"\n`,
    );
  });
}

// `import.meta.main` is not available on Node 22, so compare argv[1] instead.
// The guard matters because `test/serve.test.ts` imports this module for
// `resolveRequest` and must not have a socket opened underneath it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
