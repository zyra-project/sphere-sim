/**
 * Load the app in a real browser and check that it worked. `node tools/smoke-app.ts`
 *
 * ## Why this exists as a tool rather than as a test
 *
 * `packages/web/test/` covers everything that can be checked without a GPU: the
 * settings, the rigs, the readout copy, the parity statistics, the shader's
 * structure, and a full live solve. What none of it can do is compile the GLSL.
 * A shader that fails to compile, or one whose uniforms the linker drops, is
 * invisible to every one of those tests and produces a black rectangle for the
 * user.
 *
 * So this drives Chromium over the DevTools protocol, using nothing but Node 22's
 * built-in `WebSocket` — no Playwright, no Puppeteer, no dependency. It is not in
 * `npm test` because it needs a browser binary that CI may not have; it is in the
 * repository because "does the shader compile" is a question somebody has to ask
 * before every deploy, and asking it by hand is how it stops being asked.
 *
 * ## What it asserts
 *
 *   1. The page reaches a rendered state with no fatal banner. The banner is what
 *      `web/main.ts` fills in on a compile failure or a missing uniform.
 *   2. The model worker replied — the headline number is present and is a number.
 *   3. Nothing was logged to the console as an error.
 *   4. The canvas is not uniformly black, which is the symptom a working shader
 *      with a broken uniform block produces.
 *
 * Usage:
 *   node tools/smoke-app.ts [--url http://localhost:8174/] [--browser PATH]
 *                           [--timeout MS] [--keep]
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CANDIDATE_BROWSERS = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

interface Options {
  url: string;
  browser: string | null;
  timeoutMs: number;
  keep: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { url: 'http://localhost:8174/', browser: null, timeoutMs: 90_000, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--url' && next) opts.url = next;
    else if (argv[i] === '--browser' && next) opts.browser = next;
    else if (argv[i] === '--timeout' && next) opts.timeoutMs = Number(next);
    else if (argv[i] === '--keep') opts.keep = true;
  }
  return opts;
}

function findBrowser(explicit: string | null): string {
  const tried: string[] = [];
  for (const c of explicit ? [explicit] : CANDIDATE_BROWSERS) {
    if (!c) continue;
    tried.push(c);
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `no Chromium found. Pass --browser PATH or set CHROME_PATH.\n  tried: ${tried.join('\n         ')}`,
  );
}

/** A minimal DevTools-protocol client over Node 22's built-in WebSocket. */
class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data));
      if (typeof msg.id === 'number') {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(
          msg.params.args.map((a: any) => a.value ?? a.description ?? a.type).join(' '),
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push(d.exception?.description ?? d.text ?? 'unknown exception');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.consoleErrors.push(msg.params.entry.text);
      }
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not open ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Find the about:blank tab Chromium opened at startup.
 *
 * `/json/list` rather than `/json/new`: recent Chromium requires a PUT for the
 * latter, and a GET answers 405 in a way that reads exactly like the browser not
 * having started yet. Reusing the startup tab needs no endpoint at all beyond
 * the listing.
 */
async function findPageTarget(port: number, attempts = 40): Promise<any> {
  const url = `http://127.0.0.1:${port}/json/list`;
  let lastError = 'no response';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = (await res.json()) as any[];
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
        lastError = `${targets.length} target(s), none of them a page`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`could not reach ${url}: ${lastError}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const browser = findBrowser(opts.browser);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-smoke-'));
  const failures: string[] = [];

  // `--enable-unsafe-swiftshader` is what makes WebGL2 available without a GPU.
  // Without it a headless Chromium answers `getContext('webgl2')` with null and
  // this tool would report a shader failure that is really an environment one.
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    // Chromium writes the port it chose into the profile directory.
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(portFile)) {
      if (Date.now() > deadline) {
        throw new Error(`Chromium did not start.\n${stderr.split('\n').slice(-8).join('\n')}`);
      }
      await sleep(150);
    }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const target = await findPageTarget(port);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: opts.url });

    process.stdout.write(`smoke-app: ${opts.url}\n`);

    // Poll for the page to reach a rendered state rather than sleeping a fixed
    // amount: the model worker's first pass takes about a second on a laptop and
    // rather longer under a software rasteriser.
    const until = Date.now() + opts.timeoutMs;
    let headline = '';
    let fatal = '';
    while (Date.now() < until) {
      await sleep(500);
      try {
        fatal = await cdp.evaluate<string>(
          "document.getElementById('fatal')?.textContent?.trim() ?? ''",
        );
        if (fatal !== '') break;
        headline = await cdp.evaluate<string>(
          "document.querySelector('.headline .big')?.textContent?.trim() ?? ''",
        );
        if (headline !== '' && !headline.includes('computing')) break;
      } catch {
        /* the document is still being replaced by the navigation */
      }
    }

    if (fatal !== '') {
      failures.push(`the page reported a fatal error:\n    ${fatal.split('\n')[0]}`);
    }
    if (headline === '' || headline.includes('computing')) {
      failures.push(
        `the model worker never replied within ${(opts.timeoutMs / 1000).toFixed(0)} s ` +
          `(headline still reads '${headline || '(empty)'}')`,
      );
    } else {
      const mm = Number.parseFloat(headline);
      if (!Number.isFinite(mm)) failures.push(`the headline is not a number: '${headline}'`);
      else process.stdout.write(`  worst grid-line error: ${headline}\n`);
    }

    // A shader that compiles but whose uniform block did not bind produces a
    // uniformly black canvas. Sample it rather than trusting the absence of an
    // error.
    const ink = await cdp.evaluate<{ nonBlack: number; total: number } | null>(`(() => {
      const c = document.getElementById('view');
      if (!c) return null;
      const off = document.createElement('canvas');
      off.width = 64; off.height = 48;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, off.width, off.height);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 12) nonBlack++;
      return { nonBlack, total: d.length / 4 };
    })()`);
    if (!ink) {
      failures.push('there is no canvas on the page');
    } else if (ink.nonBlack === 0) {
      failures.push('the canvas is uniformly black — the shader ran and drew nothing');
    } else {
      process.stdout.write(
        `  canvas: ${((ink.nonBlack / ink.total) * 100).toFixed(1)}% of sampled pixels are lit\n`,
      );
    }

    const parity = await cdp.evaluate<string>(
      "document.querySelector('.parity')?.className ?? '(none)'",
    );
    process.stdout.write(`  parity: ${parity}\n`);
    if (parity.includes('bad')) {
      const why = await cdp.evaluate<string>(
        "document.querySelector('.parity')?.textContent?.trim() ?? ''",
      );
      failures.push(`the shader disagrees with packages/sim:\n    ${why.slice(0, 400)}`);
    }

    for (const e of cdp.pageErrors) failures.push(`uncaught in the page: ${e.split('\n')[0]}`);
    for (const e of cdp.consoleErrors) failures.push(`console error: ${e.split('\n')[0]}`);

    cdp.close();
  } finally {
    child.kill('SIGKILL');
    if (!opts.keep) fs.rmSync(profile, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(`\nsmoke-app FAILED\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.stderr.write('\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('smoke-app: the shader compiled, the workers replied, the picture is lit.\n');
}

void main();
