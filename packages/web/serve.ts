/**
 * The app's static server. `npm run app`.
 *
 * Zero dependencies, the same rule the rest of the project follows: a dev server
 * that needs an `npm install` is a dev server that stops working the day the
 * registry is unreachable, and this one exists partly for the case where
 * somebody is standing next to a sphere with a laptop.
 *
 * ## Cross-origin isolation, and why the headers are here
 *
 * The page runs two module workers. Nothing here uses `SharedArrayBuffer`
 * today, but the two headers below are what a browser requires before it will
 * hand one out, and setting them in development means a later change that wants
 * shared memory fails in the same place on both a laptop and GitHub Pages rather
 * than only in production. They also cost nothing: every asset this page loads
 * is same-origin.
 *
 * It reuses `packages/harness/serve.ts`'s path resolution rather than writing a
 * second one. That is not a boundary concern — neither package is `sim` or
 * `solver` — and a hand-rolled second copy of a directory-traversal check is
 * exactly the kind of duplication that is worth avoiding, since the second copy
 * is the one nobody tests.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentTypeOf, resolveRequest } from '../harness/serve.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
/** The browser bundle the page loads. Exported so tools can say why a page is blank. */
export const BUNDLE = path.join(HERE, 'dist', 'web', 'web', 'main.js');

export function createServer(appRoot: string = HERE, repoRoot: string = REPO_ROOT): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('only GET and HEAD are served\n');
      return;
    }
    const resolution = resolveRequest(req.url ?? '/', appRoot, repoRoot);
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
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  });
}

function main(): void {
  const port = Number(process.env.PORT ?? 8174);
  if (!fs.existsSync(BUNDLE)) {
    process.stderr.write(
      `\npackages/web: the browser bundle is missing.\n\n` +
        `  expected: ${path.relative(REPO_ROOT, BUNDLE)}\n` +
        `  build it: npm run build:app\n\n` +
        `Serving anyway so the page's error banner is visible, but nothing will render.\n\n`,
    );
  }
  createServer().listen(port, () => {
    process.stdout.write(
      `sphere-sim installation simulator on http://localhost:${port}/\n` +
        `  the picture is a shader; every number beside it comes from packages/sim in a worker\n` +
        `  Recalibrate runs packages/solver on structured light the simulator photographed\n`,
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
