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
 *                           [--timeout MS] [--keep] [--solve]
 *                           [--screenshot out.png]
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The phone the last pass emulates: an iPhone 14/15 in portrait, in CSS pixels. */
const PHONE_W = 390;
const PHONE_H = 844;

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
  /** Also press Recalibrate and wait for a result. */
  solve: boolean;
  /** Write a PNG of the page here. */
  screenshot: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    url: 'http://localhost:8174/',
    browser: null,
    timeoutMs: 90_000,
    keep: false,
    solve: false,
    screenshot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--url' && next) opts.url = next;
    else if (argv[i] === '--browser' && next) opts.browser = next;
    else if (argv[i] === '--timeout' && next) opts.timeoutMs = Number(next);
    else if (argv[i] === '--keep') opts.keep = true;
    else if (argv[i] === '--solve') opts.solve = true;
    else if (argv[i] === '--screenshot' && next) opts.screenshot = next;
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
      '--window-size=1600,1000',
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
          "document.querySelector('[data-smoke=\"grid-mm\"]')?.textContent?.trim() ?? ''",
        );
        if (headline !== '' && headline !== '\u2014') break;
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

    // The help sheet opens itself on a first visit — which is what a fresh
    // profile always is — and everything behind it is unreachable until it
    // closes. Check both halves and then get it out of the way, so the
    // screenshot below is of the page rather than of the introduction.
    const helpOpen = await cdp.evaluate<boolean>(
      "document.getElementById('help')?.classList.contains('on') ?? false",
    );
    if (!helpOpen) {
      failures.push('the help sheet did not open on a first visit');
    } else {
      await cdp.evaluate<boolean>(`(() => {
        const b = document.querySelector('#help [data-smoke="help-close"]');
        if (!(b instanceof HTMLElement)) return false;
        b.click();
        return true;
      })()`);
      await sleep(300);
      const stillOpen = await cdp.evaluate<boolean>(
        "document.getElementById('help')?.classList.contains('on') ?? false",
      );
      if (stillOpen) failures.push('the help sheet would not close');
    }

    // Put a flat, colourless field on the sphere first. The marker hunt below
    // finds projectors by their HUE, and Earth is full of saturated orange
    // desert — which the scan cheerfully reported as 1154 pixels of P3 and then
    // clicked, landing on the Sahara.
    await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('#controls .seg button')]
        .find((b) => /Room/.test(b.textContent ?? ''));
      if (tab) tab.click();
      const flat = [...document.querySelectorAll('#controls button')]
        .find((b) => (b.textContent ?? '').trim() === 'Black');
      if (flat) flat.click();
      return !!flat;
    })()`);
    await sleep(1200);

    // Step outside the ring first. At the default viewpoint you are standing
    // between two of the projectors and cannot see them, which is true of the
    // real room; the whole-room viewpoint is the one that claims to show all
    // four, so it is the one worth checking.
    const stepped = await cdp.evaluate<boolean>(`(() => {
      const tab = [...document.querySelectorAll('#controls .seg button')]
        .find((b) => /Room/.test(b.textContent ?? ''));
      if (!tab) return false;
      tab.click();
      const chip = [...document.querySelectorAll('#controls button')]
        .find((b) => /Whole room/.test(b.textContent ?? ''));
      if (!chip) return false;
      chip.click();
      return true;
    })()`);
    if (!stepped) failures.push('there is no "Whole room" viewpoint on the Room tab');
    await sleep(1200);

    // The lens markers, and the click that picks one.
    //
    // There are two implementations of where a marker is: the shader's
    // `markerHit`, which draws it, and `uniforms.ts`'s `pickMarker`, which
    // decides what a click landed on. Nothing in Node can compare them — one of
    // them is GLSL. So this finds a marker by its COLOUR in the rendered canvas
    // and clicks it, and the assertion is that the projector the CPU picked is
    // the one whose tint the GPU painted there. If the two ray-casts ever drift,
    // the click selects the wrong projector and this fails.
    const markers = await cdp.evaluate<{ found: number[]; spot: ({ x: number; y: number } | null)[] }>(`(() => {
      const c = document.getElementById('view');
      const rect = c.getBoundingClientRect();
      const W = Math.round(rect.width), H = Math.round(rect.height);
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      // The four panel colours, as hues. Everything else the shader draws — the
      // sphere, the floor — is grey, so saturation alone separates a marker from
      // the room and the hue says which projector it is.
      const hues = [180, 279, 30, 120];
      const found = [0, 0, 0, 0];
      const spot = [null, null, null, null];
      const inBand = [[], [], [], []];
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const i = 4 * (y * W + x);
          const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx < 0.12 || mx === mn) continue;
          if ((mx - mn) / mx < 0.25) continue;
          let h;
          if (mx === r) h = 60 * ((((g - b) / (mx - mn)) % 6 + 6) % 6);
          else if (mx === g) h = 60 * (((b - r) / (mx - mn)) + 2);
          else h = 60 * (((r - g) / (mx - mn)) + 4);
          let best = -1, bestD = 25;
          for (let k = 0; k < 4; k++) {
            let dh = Math.abs(h - hues[k]);
            if (dh > 180) dh = 360 - dh;
            if (dh < bestD) { bestD = dh; best = k; }
          }
          if (best < 0) continue;
          found[best]++;
          // Only somewhere the control panels are not, or the click lands on a
          // slider instead of on the room.
          if (x > W * 0.30 && x < W * 0.74) inBand[best].push([x, y]);
        }
      }
      // Aim at the pixel nearest the centroid rather than at the first one found.
      // The first is on the marker's top edge, where the ray grazes the sphere
      // and a pixel of rounding misses it entirely — which would look exactly
      // like the picker disagreeing with the shader.
      for (let k = 0; k < 4; k++) {
        const px = inBand[k];
        if (px.length < 4) continue;
        const cx = px.reduce((a, p) => a + p[0], 0) / px.length;
        const cy = px.reduce((a, p) => a + p[1], 0) / px.length;
        let bestP = px[0], bestD = Infinity;
        for (const p of px) {
          const d2 = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
          if (d2 < bestD) { bestD = d2; bestP = p; }
        }
        spot[k] = { x: Math.round(rect.left + bestP[0]), y: Math.round(rect.top + bestP[1]) };
      }
      return { found, spot };
    })()`);
    const lit = markers.found.filter((n) => n > 0).length;
    process.stdout.write(`  lens markers: ${lit} of 4 tints on screen (${markers.found.join('/')} px)\n`);
    if (stepped && lit < 4) {
      failures.push(
        `the whole-room viewpoint shows ${lit} of 4 projectors — it exists to show all of them`,
      );
    }

    const pickIndex = markers.spot.findIndex((s) => s !== null);
    if (pickIndex < 0 && lit > 0) {
      process.stdout.write('  (no marker in the clickable band; skipping the pick)\n');
    } else if (pickIndex >= 0) {
      const at = markers.spot[pickIndex]!;
      for (const type of ['mousePressed', 'mouseReleased'] as const) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: at.x,
          y: at.y,
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
          pointerType: 'mouse',
        });
      }
      await sleep(400);
      const selected = await cdp.evaluate<number>(
        "Number(document.getElementById('view')?.dataset.selected ?? -1)",
      );
      if (selected !== pickIndex) {
        failures.push(
          `clicking the P${pickIndex + 1} marker at (${at.x}, ${at.y}) selected ` +
            `${selected < 0 ? 'nothing' : `P${selected + 1}`} — the shader and the picker disagree`,
        );
      } else {
        process.stdout.write(`  clicked the P${pickIndex + 1} marker and P${pickIndex + 1} was selected\n`);
      }
      // Selecting is selecting. A click used to isolate as well, which put the
      // other three projectors out — a room gone dark in response to the mildest
      // gesture on the page, and indistinguishable from having switched them off.
      const isolated = await cdp.evaluate<number>(
        "Number(document.getElementById('view')?.dataset.highlight ?? -1)",
      );
      if (isolated !== -1) {
        failures.push(
          `clicking a projector isolated it (highlight=${isolated}); the other projectors went out`,
        );
      }
    }

    const parity = await cdp.evaluate<string>(
      "document.querySelector('[data-smoke=\"parity\"]')?.dataset.state ?? '(none)'",
    );
    process.stdout.write(`  parity: ${parity}\n`);
    if (parity === 'bad') {
      const why = await cdp.evaluate<string>(
        "document.querySelector('[data-smoke=\"parity\"]')?.textContent?.trim() ?? ''",
      );
      failures.push(`the shader disagrees with packages/sim:\n    ${why.slice(0, 400)}`);
    }
    if (parity === '(none)') {
      failures.push('the parity section never rendered — the readout did not reach a settled state');
    }

    // The live calibration, end to end, in a browser: the one claim on this page
    // that a CPU test in Node cannot make, because it depends on both workers
    // starting, the module graph resolving in a worker context, and the whole
    // capture-and-solve pipeline surviving structured cloning.
    if (opts.solve) {
      // The page opens on an ALIGNED rig, so there is nothing for a solve to
      // recover until something is broken. "Another install" draws the §2 mount
      // tolerances, which is what an operator is actually calibrating away.
      await cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('#actions button')]
          .find((x) => /Another install/.test(x.textContent ?? ''));
        if (b) b.click();
        return !!b;
      })()`);
      // Wait for the model worker to report the BROKEN rig, rather than sleeping
      // a guessed interval. `headline` still holds the aligned figure, and
      // comparing that against the post-solve one compares two different
      // installations and calls a working calibration a regression.
      const breakDeadline = Date.now() + 30_000;
      while (Date.now() < breakDeadline) {
        await sleep(400);
        const now = await cdp.evaluate<string>(
          "document.querySelector('[data-smoke=\"grid-mm\"]')?.textContent?.trim() ?? ''",
        );
        const mm = Number.parseFloat(now);
        if (Number.isFinite(mm) && mm > 1) {
          headline = now;
          break;
        }
      }
      if (Number.parseFloat(headline) <= 1) {
        failures.push('"Another install" did not break the rig, so the solve has nothing to recover');
      }

      const started = await cdp.evaluate<boolean>(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Recalibrate/.test(x.textContent ?? ''));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!started) {
        failures.push('there is no Recalibrate button on the page');
      } else {
        const before = Number.parseFloat(headline);
        process.stdout.write(`  solving… (${headline} mm before)\n`);
        const solveUntil = Date.now() + Math.max(opts.timeoutMs, 240_000);
        let stage = '';
        let done = false;
        while (Date.now() < solveUntil) {
          await sleep(1000);
          // Wait for the IMPROVEMENT line, not merely for the result card: the
          // solve finishing and the metrics being recomputed against the
          // recovered rig are two events, and reading the headline between them
          // reports the pre-calibration number as though it were the outcome.
          const s = await cdp.evaluate<{ stage: string; done: boolean }>(`(() => {
            const t = document.querySelector('#readout')?.textContent ?? '';
            const improved = document.querySelector('[data-smoke="improvement"]') !== null;
            return { stage: /Fitting[^.]*/.exec(t)?.[0] ?? '', done: improved };
          })()`);
          if (s.done) {
            done = true;
            break;
          }
          stage = s.stage;
        }
        if (!done) {
          failures.push(`the solve never produced a result${stage ? ` (last stage: ${stage})` : ''}`);
        } else {
          const summary = await cdp.evaluate<string>(
            "document.querySelector('[data-smoke=\"grid-mm\"]')?.textContent?.trim() ?? ''",
          );
          const shots = await cdp.evaluate<number>(
            "document.querySelectorAll('#readout .shots figure').length",
          );
          const improvement = await cdp.evaluate<string>(
            "document.querySelector('[data-smoke=\"improvement\"]')?.textContent?.trim() ?? ''",
          );
          process.stdout.write(`  after calibration: ${summary} mm, ${shots} capture thumbnail(s)\n`);
          process.stdout.write(`  ${improvement}\n`);
          if (shots === 0) failures.push('the solve produced no capture thumbnails');
          if (Number.parseFloat(summary) >= before) {
            failures.push(
              `the calibration did not improve the alignment: ${before} mm before, ${summary} mm after`,
            );
          }
        }
      }
    }

    // The inspect card shows one view at a time; the mesh is the third.
    //
    // Opened by name rather than assumed. The card is opened by clicking a lens
    // in the room, and which lens is in the clickable band depends on where the
    // renderer put the markers — CI picks a different one from this machine —
    // so this makes sure a projector is selected and the card is up before
    // asking it for a picture, instead of inheriting whatever the pick left.
    //
    // And polled rather than slept on: the mesh arrives with a model reply, and
    // a fixed 200 ms is a race that this machine wins and a slower one loses.
    const mesh = await (async () => {
      for (let i = 0; i < 40; i++) {
        const got = await cdp.evaluate<{
          h: number; grey: number; tinted: number; state: string;
        } | null>(`(() => {
          const card = document.getElementById('inspect');
          if (!card || !card.classList.contains('on') || card.children.length === 0) {
            const tab = [...document.querySelectorAll('#controls button')]
              .find((b) => (b.textContent ?? '').trim() === 'Projectors');
            if (tab) tab.click();
            const p = [...document.querySelectorAll('.ptabs button')]
              .find((b) => !b.className.includes('on') && !b.className.includes('dark'));
            if (p) p.click();
            return null;
          }
          const b = [...card.querySelectorAll('.seg button')]
            .find((x) => /Warp mesh/.test(x.textContent ?? ''));
          if (b && !b.className.includes('on')) b.click();
          const svg = card.querySelector('svg');
          if (!svg) {
            return { h: 0, grey: 0, tinted: 0, state: 'card up, no svg: ' +
              [...card.querySelectorAll('.seg button')].map((x) => x.textContent).join('/') };
          }
          const groups = [...svg.querySelectorAll('g')];
          const count = (n) => groups[n] ? groups[n].querySelectorAll('polyline').length : 0;
          return {
            h: Math.round(svg.getBoundingClientRect().height),
            grey: count(0), tinted: count(1), state: 'ok',
          };
        })()`);
        if (got && got.h >= 40 && got.grey >= 8 && got.tinted >= 8) return got;
        await sleep(250);
        if (i === 39) return got;
      }
      return null;
    })();
    if (!mesh) {
      failures.push('the projector card never opened, so there was nothing to show a mesh in');
    } else if (mesh.state !== 'ok') {
      failures.push(`the selected projector shows no warp mesh — ${mesh.state}`);
    } else if (mesh.h < 40) {
      failures.push(`the warp mesh drew at ${mesh.h} px tall — it has been squashed away`);
    } else if (mesh.grey < 8 || mesh.tinted < 8) {
      failures.push(
        `the warp mesh has ${mesh.grey} raster lines and ${mesh.tinted} corrected ones`,
      );
    } else {
      process.stdout.write(`  warp mesh: ${mesh.h} px tall, ${mesh.tinted} corrected lines\n`);
    }

    // The enlarged preview is a re-render, not an upscale, and after a solve it
    // is a comparison with three ways of reading it. Both halves come from their
    // own worker request against a named calibration, so this also checks that
    // the "before" rig survived the solve that replaced it.
    if (opts.solve) {
      // Back to the frame tab first: the warp-mesh check above left the card on
      // its third view, where there is no frame to click. The check caught that
      // as "no lightbox", which is what it should say and not what it meant.
      await cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('#inspect .seg button')]
          .find((x) => /Its frame/.test(x.textContent ?? ''));
        if (b) b.click();
      })()`);
      await sleep(500);
      await cdp.evaluate("document.querySelector('#inspect canvas.framepic')?.click()");
      await sleep(3500);
      const lb = await cdp.evaluate<{ modes: string[]; w: number; before: number } | null>(`(() => {
        const box = document.getElementById('lightbox');
        if (!box || !box.classList.contains('on')) return null;
        const a = document.getElementById('lightbox-canvas');
        const b = document.getElementById('lightbox-canvas-b');
        return {
          modes: [...box.querySelectorAll('.modes .chip')].map((c) => c.textContent),
          w: a ? a.width : 0,
          before: b ? b.width : 0,
        };
      })()`);
      if (!lb) {
        failures.push('clicking the projector frame opened no lightbox');
      } else if (lb.w < 700) {
        failures.push(`the enlarged frame is ${lb.w} px wide — it is being upscaled, not re-rendered`);
      } else if (lb.modes.length !== 3) {
        failures.push(
          `the enlarged comparison offers ${lb.modes.length} ways to read it (${lb.modes.join(', ')}), expected overlay, blink and side by side`,
        );
      } else {
        process.stdout.write(`  enlarged frame: ${lb.w} px · ${lb.modes.join(' / ')}\n`);
      }

      // Side by side, the two frames differ by a sub-percent warp shift, so
      // which is which has to be written on them. Blink stacks the same two
      // panes exactly, and that congruence is the mode: a few pixels of offset
      // between them would read as the difference it exists to show.
      const pair = await cdp.evaluate<{
        labels: string[];
        pair: number[][];
        blink: number[][];
      } | null>(`(() => {
        const box = document.getElementById('lightbox');
        if (!box || !box.classList.contains('on')) return null;
        const chip = (t) => [...box.querySelectorAll('.modes .chip')]
          .find((c) => (c.textContent ?? '').trim() === t);
        const rects = () => [...box.querySelectorAll('.pane')].map((p) => {
          const r = p.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        });
        chip('Side by side')?.click();
        const labels = [...box.querySelectorAll('.lbl')].map((l) => (l.textContent ?? '').trim());
        const pair = rects();
        chip('Blink')?.click();
        const blink = rects();
        return { labels, pair, blink };
      })()`);
      if (!pair) {
        failures.push('the enlarged comparison closed before its modes could be read');
      } else if (pair.labels[0] !== 'before' || pair.labels[1] !== 'after') {
        failures.push(
          `side by side labels its panes ${JSON.stringify(pair.labels)} — a reader cannot tell ` +
            'the recalibrated frame from the one it replaced',
        );
      } else if (JSON.stringify(pair.blink[0]) !== JSON.stringify(pair.blink[1])) {
        failures.push(
          `blink draws its two frames at ${JSON.stringify(pair.blink)} — they must be congruent, ` +
            'or the offset between them reads as the difference',
        );
      } else {
        process.stdout.write('  comparison: panes labelled before/after, blink congruent\n');
      }
      await cdp.evaluate("document.getElementById('lightbox')?.click()");
      await sleep(300);
    }

    // The seam close-up is the one picture of the thing the page is about, and
    // it is built from two rigs composed together — run it with one rig twice
    // and it draws a perfectly aligned installation, which is exactly the
    // failure that looks like success.
    const seam = await cdp.evaluate<{
      chips: string[];
      svgs: number;
      height: number;
      scale: string;
    } | null>(`(() => {
      const s = [...document.querySelectorAll('#readout .sect')]
        .find((x) => /At the seams/i.test(x.textContent ?? ''));
      if (!s) return null;
      const svg = s.querySelector('svg');
      return {
        chips: [...s.querySelectorAll('.chip')].map((c) => c.textContent),
        svgs: s.querySelectorAll('svg').length,
        height: svg ? Math.round(svg.getBoundingClientRect().height) : 0,
        scale: [...s.querySelectorAll('p')].map((p) => p.textContent).find((t) => /scale|magnified/.test(t ?? '')) ?? '',
      };
    })()`);
    if (!seam) {
      failures.push('the readout has no seam section — the doubled line is not drawn anywhere');
    } else if (seam.chips.length < 2) {
      failures.push(`the seam picker offers ${seam.chips.length} seams`);
    } else if (seam.height < 40) {
      failures.push(`the seam diagram drew at ${seam.height} px tall`);
    } else if (seam.scale === '') {
      failures.push('the seam diagram does not say what scale it is drawn at');
    } else {
      process.stdout.write(
        `  seams: ${seam.chips.join(' ')} · ${seam.height} px · ${seam.scale}\n`,
      );
      // After a solve there are two of them, before and after.
      if (opts.solve && seam.svgs < 2) {
        failures.push('a solve produced no before-and-after seam comparison');
      }
    }

    // The seam chips are a picker AND a camera move: the diagram is a
    // measurement drawn at a stated exaggeration, the sphere is the thing
    // itself, and a reader who has just read "74.3 mm apart" should be able to
    // go and look at 74.3 mm. Nothing on the page said which way to drag.
    //
    // Checked geometrically rather than against a stored number: on a ring of
    // four the seams are the four midpoints between neighbouring lenses, so they
    // are 90 degrees apart, and a bug that walked to the LENS instead would
    // still be 90 degrees apart but would not be idempotent under a re-click if
    // it were accumulating, nor land between two of them.
    if (seam && seam.chips.length >= 2) {
      const walk = async (label: string): Promise<{ az: number; range: number }> => {
        const before = await cdp.evaluate<string>(
          "document.getElementById('view').dataset.az + '|' + document.getElementById('view').dataset.range",
        );
        const hit = await cdp.evaluate<string>(`(() => {
          const s = [...document.querySelectorAll('#readout .sect')]
            .find((x) => /At the seams/i.test(x.textContent ?? ''));
          if (!s) return 'no section';
          const all = [...s.querySelectorAll('.chip')];
          const c = all.find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(label)});
          if (c) c.click();
          return c ? 'ok' : 'no chip; had ' + all.map((b) => (b.textContent||'').trim()).join('/');
        })()`);
        if (hit !== 'ok') failures.push(`the seam picker lost its ${label} chip: ${hit}`);
        // Wait for the value to MOVE, not merely to hold still.
        //
        // `dataset.az` is written by `draw()`, so it is a frame behind the click,
        // and under a software rasteriser a supersampled redraw of a full window
        // takes long enough to matter. Polling for two identical readings is not
        // enough and fails in the direction that looks like a bug: the previous
        // seam's azimuth is perfectly stable until the redraw lands, so the check
        // read it four times and reported four chips walking to one place. Every
        // call here is a move to a different seam, so a value equal to the one
        // before the click has not arrived yet.
        const read = (): Promise<string> =>
          cdp.evaluate<string>(
            "document.getElementById('view').dataset.az + '|' + document.getElementById('view').dataset.range",
          );
        let last = before;
        for (let i = 0; i < 25 && last === before; i++) {
          await sleep(400);
          last = await read();
        }
        const [az, range] = last.split('|');
        return { az: Number.parseFloat(az), range: Number.parseFloat(range) };
      };

      const names = seam.chips.map((c) => (c ?? '').trim());
      const stops: { az: number; range: number }[] = [];
      for (const name of names) stops.push(await walk(name));
      // Back to the first one, which must be exactly where it was.
      const again = await walk(names[0]);

      const radiusM = 0.8636; // the default 68-inch ball
      const tooFar = stops.filter((s) => !(s.range > radiusM && s.range < 4));
      const gaps = stops.map((s, i) => {
        const d = Math.abs(((s.az - stops[(i + 1) % stops.length].az + 540) % 360) - 180);
        return Math.round(d);
      });
      const spread = new Set(stops.map((s) => Math.round(s.az))).size;

      if (tooFar.length > 0) {
        failures.push(
          `a seam chip left the camera at ${tooFar.map((s) => s.range.toFixed(2)).join(', ')} m — ` +
            'it is meant to come in close enough to see the doubling at full size, and to stay ' +
            'outside the ball',
        );
      } else if (spread !== stops.length) {
        failures.push(
          `${stops.length} seam chips moved the camera to ${spread} distinct azimuths ` +
            `(${stops.map((s) => s.az.toFixed(0)).join(', ')}) — they are not walking to their own seam`,
        );
      } else if (stops.length === 4 && gaps.some((g) => Math.abs(g - 90) > 12)) {
        failures.push(
          `the four seams of a four-projector ring must be about 90° apart; the chips walked to ` +
            `${stops.map((s) => s.az.toFixed(0)).join(', ')}, with gaps ${gaps.join(', ')}`,
        );
      } else if (
        Math.abs(again.az - stops[0].az) > 0.5 ||
        Math.abs(again.range - stops[0].range) > 0.02
      ) {
        failures.push(
          `going back to ${names[0]} landed somewhere else: ${again.az.toFixed(1)}°, ` +
            `${again.range.toFixed(2)} m against ${stops[0].az.toFixed(1)}°, ` +
            `${stops[0].range.toFixed(2)} m — the camera move is accumulating`,
        );
      } else {
        process.stdout.write(
          `  seam chips walked to ${stops.map((s) => `${s.az.toFixed(0)}°`).join(' ')} ` +
            `at ${stops[0].range.toFixed(2)} m\n`,
        );
      }
    }

    // Switching a projector off at the wall is now done by clicking the tab of
    // the projector you are already on, and there is no other control that does
    // it — the labelled On / "Off at the wall" pair that used to sit under these
    // tabs is gone. A gesture that is the ONLY way to reach a state has to be
    // asserted, because nothing else on the page will notice if it stops working.
    const wall = await cdp.evaluate<string[] | null>(`(() => {
      const tab = [...document.querySelectorAll('#controls .seg button')]
        .find((b) => /Projectors/.test(b.textContent ?? ''));
      if (!tab) return null;
      tab.click();
      // The SELECTED tab, not the first: an earlier check clicks a lens in the
      // room, which selects whichever projector it hit. Keying off position
      // would fail here for a reason that has nothing to do with the switch.
      const tabs = () => [...document.querySelectorAll('#controls .ptabs button')];
      const chosen = tabs().findIndex((b) => b.className.includes('on'));
      if (chosen < 0) return ['no tab is selected'];
      const at = () => tabs()[chosen]?.className ?? '(none)';
      const seen = [at()];
      // Selected already, so this click is the switch.
      tabs()[chosen]?.click();
      seen.push(at());
      tabs()[chosen]?.click();
      seen.push(at());
      // And nothing else on the tab offers the same thing.
      const strays = [...document.querySelectorAll('#controls .chip')]
        .filter((c) => /^(On|Off at the wall)$/.test((c.textContent ?? '').trim())).length;
      seen.push('strays=' + strays);
      return seen;
    })()`);
    if (!wall) {
      failures.push('the Projectors tab has no projector tabs');
    } else {
      const [start, off, back, strays] = wall;
      if (wall.length === 1) {
        failures.push(`the projector tab check could not run: ${start}`);
      } else if (!start.includes('on')) {
        failures.push(`the selected projector tab is not marked selected (class '${start}')`);
      } else if (!off.includes('dark')) {
        failures.push(
          `clicking the selected projector tab did not switch it off at the wall (class '${off}')`,
        );
      } else if (back.includes('dark')) {
        failures.push(`clicking it again did not switch it back on (class '${back}')`);
      } else if (strays !== 'strays=0') {
        failures.push(
          `the Projectors tab still carries a separate On / Off pair (${strays}) — two controls ` +
            'for one action',
        );
      } else {
        process.stdout.write('  projector tab: select, off at the wall, back on\n');
      }
    }

    // The Room tab is ordered by how often a control is reached for, not by how
    // important the constant behind it is. That is easy to say and easy to undo,
    // so it is asserted: the grid — which a reader toggles on every look — must
    // come before the compositor's constants, which are class ASSUME and are set
    // once if ever, and those constants must start put away.
    const panel = await cdp.evaluate<{
      order: string[];
      constantsShowing: number;
      afterOpen: number;
      caret: string;
    } | null>(`(() => {
      const tab = [...document.querySelectorAll('#controls .seg button')]
        .find((b) => /Room/.test(b.textContent ?? ''));
      if (!tab) return null;
      tab.click();
      const marks = () => {
        const kids = [...document.getElementById('controls').children];
        const at = (test) => kids.findIndex((n) => test((n.textContent ?? '').trim()));
        return {
          grid: at((t) => /^Grid lines/.test(t)),
          looking: at((t) => /^What you are looking at/.test(t)),
          discl: kids.findIndex((n) => n.classList && n.classList.contains('discl')),
        };
      };
      const countConstants = () =>
        [...document.querySelectorAll('#controls .sl .lab')]
          .filter((l) => /Seam blend width|Blend ramp|Bottom mask/.test(l.textContent ?? ''))
          .length;
      const m = marks();
      const before = countConstants();
      const caret = (document.querySelector('#controls .discl')?.textContent ?? '').trim().slice(0, 1);
      document.querySelector('#controls .discl')?.click();
      return {
        order: [String(m.grid), String(m.looking), String(m.discl)],
        constantsShowing: before,
        afterOpen: countConstants(),
        caret,
      };
    })()`);
    if (!panel) {
      failures.push('the Room tab has no segmented tab to click');
    } else {
      const [grid, looking, discl] = panel.order.map(Number);
      if (grid < 0 || looking < 0 || discl < 0) {
        failures.push(
          `the Room tab is missing one of its landmarks (grid ${grid}, display block ${looking}, ` +
            `disclosure ${discl})`,
        );
      } else if (!(grid < looking && looking < discl)) {
        failures.push(
          `the Room tab is out of order: grid at ${grid}, the display block at ${looking}, the ` +
            `compositor's constants at ${discl}. The controls a reader touches on every look must ` +
            'come before the ones nobody moves twice.',
        );
      } else if (panel.constantsShowing !== 0) {
        failures.push(
          `${panel.constantsShowing} ASSUME-class constants are showing before anybody asked — ` +
            'they are meant to start behind the caret',
        );
      } else if (panel.afterOpen < 4) {
        failures.push(
          `opening the disclosure revealed ${panel.afterOpen} constants, expected the four §4.4/` +
            '§4.5 sliders — the caret is not connected to anything',
        );
      } else {
        process.stdout.write(
          `  panel: grid at ${grid}, display block at ${looking}, ${panel.afterOpen} constants ` +
            `behind the caret\n`,
        );
      }
    }

    // The two capture inputs. There is no noise slider on purpose — the
    // millimetres are what the simulator produces — so these are what an
    // operator actually decides, and every one of them was declared, sent and
    // never written to by anything before.
    const capture = await cdp.evaluate<{ chips: string[]; flipped: boolean } | null>(`(() => {
      const tab = [...document.querySelectorAll('#controls button')]
        .find((b) => (b.textContent ?? '').trim() === 'Install');
      if (!tab) return null;
      tab.click();
      const named = (t) => [...document.querySelectorAll('#controls .chip')]
        .find((c) => (c.textContent ?? '').trim() === t);
      const hand = named('Handheld');
      if (!hand) return null;
      hand.click();
      return {
        chips: [...document.querySelectorAll('#controls .chip')]
          .map((c) => (c.textContent ?? '').trim()),
        flipped: (named('Handheld')?.className ?? '').includes('on'),
      };
    })()`);
    if (!capture) {
      failures.push('the panel offers no tripod-or-handheld choice for the capture');
    } else if (!capture.flipped) {
      failures.push('clicking "Handheld" did not select it — the capture control is not wired');
    } else if (!['1', '2', '3', '4'].every((n) => capture.chips.includes(n))) {
      failures.push('the panel offers no choice of how many camera positions to photograph from');
    } else if (!capture.chips.some((c) => /^640\s*.\s*480$/.test(c))) {
      failures.push(
        'the panel offers no camera raster above the bench corpus — 320x240 is coarser than a ' +
          'phone and the page would have no way to say so',
      );
    } else {
      process.stdout.write(
        '  capture: tripod / handheld, 1-4 positions, and a camera raster, all live\n',
      );
    }

    // Last, because both of these move the rig or the eye, and every check above
    // reads the before-and-after snapshots that a movement is meant to void.
    //
    // What the software BELIEVES survives everything except being told to forget
    // it. Two controls used to throw it away silently.
    if (opts.solve) {
      /**
       * The headline number, once it has stopped moving.
       *
       * A coarse pass and a fine one disagree in the hundredths — that is what
       * the density difference is FOR — so reading the instant a click returns
       * catches whichever happened to have landed, and the same run passes or
       * fails by timing. Both checks below ask whether a whole calibration
       * survived, which is a change of TENS of millimetres, so they wait for
       * quiet and then compare magnitudes rather than strings.
       */
      const settled = async (from?: number): Promise<number> => {
        let last = '';
        let stable = 0;
        for (let i = 0; i < 60; i++) {
          const now = await cdp.evaluate<string>(
            "document.querySelector('[data-smoke=\"grid-mm\"]')?.textContent?.trim() ?? ''",
          );
          stable = now === last ? stable + 1 : 0;
          last = now;
          // `from` is the value this is expected to move AWAY from. Without it,
          // a quiet second before the worker's answer arrives reads as settled,
          // and the check reports the pre-change number as the outcome.
          const moved = from === undefined || Number.parseFloat(now) !== from;
          if (stable >= 5 && moved) break;
          await sleep(200);
        }
        return Number.parseFloat(last);
      };
      const solved = await settled();

      // Walking round the ball is the first. A viewpoint chip moves the eye and
      // nothing else, and it was discarding the calibration — so going to look at
      // the seam you had just fixed un-fixed it.
      await cdp.evaluate(`(() => {
        const room = [...document.querySelectorAll('#controls button')]
          .find((b) => (b.textContent ?? '').trim() === 'Room');
        if (room) room.click();
        const chip = [...document.querySelectorAll('#controls .chip')]
          .find((c) => (c.textContent ?? '').trim() === 'At a seam');
        if (chip) chip.click();
        return !!chip;
      })()`);
      const afterView = await settled();
      if (Math.abs(afterView - solved) > 1) {
        failures.push(
          `moving the eye changed the measurement: ${solved} mm before the viewpoint chip, ` +
            `${afterView} mm after — a view control has discarded the calibration`,
        );
      } else {
        process.stdout.write(
          `  walking to a seam left the calibration alone (${solved} → ${afterView} mm)\n`,
        );
      }

      // Knocking a lens is the second, and it is the page's own headline
      // demonstration: the software goes on sending exactly what it sent before,
      // so the error grows and the frame does not change. That only holds if the
      // recovered rig outlives the bump.
      // Aim it at a projector that is actually lit. Bumping one that is switched
      // off at the wall moves a lens the model is not drawing, so nothing on the
      // page changes and the check below would fail for the wrong reason.
      const aimed = await cdp.evaluate<string>(`(() => {
        const proj = [...document.querySelectorAll('#controls button')]
          .find((b) => (b.textContent ?? '').trim() === 'Projectors');
        if (proj) proj.click();
        const tabs = [...document.querySelectorAll('.ptabs button')];
        if (!tabs.length) return 'no projector tabs';
        const lit = tabs.find((t) => !t.className.includes('dark'));
        if (!lit) return 'every projector is switched off';
        // Only if it is not already the selected one. A second click on the
        // SELECTED tab is the shortcut that switches that projector off at the
        // wall, which would silently make the bump below a no-op.
        if (!lit.className.includes('on')) lit.click();
        return 'ok ' + (lit.textContent ?? '').trim();
      })()`);
      if (!aimed.startsWith('ok')) failures.push(`could not pick a lit projector: ${aimed}`);
      await sleep(500);
      const bumped = await cdp.evaluate<string>(`(() => {
        const b = [...document.querySelectorAll('#actions .btn')]
          .find((x) => /Bump this one/.test(x.textContent ?? ''));
        if (!b) return 'no bump button: ' + [...document.querySelectorAll('#actions .btn')]
          .map((x) => (x.textContent ?? '').trim()).join('/');
        b.click();
        return 'ok';
      })()`);
      if (!bumped.startsWith('ok')) failures.push(bumped);
      // Poll for the OUTCOME, not for quiet. A quarter-degree knock is worth tens
      // of millimetres; the difference between a coarse pass and a fine one is
      // worth hundredths. Waiting for "it changed" cannot tell those apart and
      // returned whichever landed first, so this waits for the number to clear
      // the threshold the claim is actually about.
      let nowMm = afterView;
      for (let i = 0; i < 100; i++) {
        nowMm = Number.parseFloat(
          await cdp.evaluate<string>(
            "document.querySelector('[data-smoke=\"grid-mm\"]')?.textContent?.trim() ?? ''",
          ),
        );
        if (nowMm > afterView + 5) break;
        await sleep(200);
      }
      // Read something the WORKER computes, not a button. `gridBaselineMm` — and
      // so the improvement line built from it — exists only while the compositor
      // is a recovered rig rather than the config as written, so its presence is
      // the model's own answer to "is there still a calibration". Keying off the
      // "Forget it" button instead would have passed either way: nothing
      // re-rendered the action bar, so the stale node was still in the DOM.
      const stillCalibrated = await cdp.evaluate<boolean>(
        "document.querySelector('[data-smoke=\"improvement\"]') !== null",
      );
      if (!stillCalibrated) {
        failures.push(
          'bumping a projector after a recalibration threw the recovered rig away — the ' +
            'compositor is back on the drawing and the frame will have changed',
        );
      } else if (!(nowMm > afterView + 5)) {
        failures.push(
          `bumping a projector barely moved the measurement (${afterView} → ${nowMm} mm, aimed ` +
            `at ${aimed}) — a quarter-degree knock is worth tens of millimetres on the sphere, ` +
            'so the bump is saturated against its clamp or it never reached the model',
        );
      } else {
        process.stdout.write(
          `  bumping again kept the recovered rig (${afterView} → ${nowMm} mm)\n`,
        );
      }
    }

    // A slider has to survive being dragged. LAST, because it leaves the sphere
    // at a different diameter and every check above reads a number that depends
    // on it.
    //
    // Every value change rebuilds the control panel, which replaces the very
    // element the pointer is on; a listener on a detached node never fires
    // again, so the drag used to die after the first step while a click carried
    // on working — the one gesture the page cannot function without, broken in
    // the way least likely to be noticed by anything checking state rather than
    // input. Real Input events, because pointer capture only behaves like the
    // browser's when the browser is delivering them.
    const dragged = await (async (): Promise<string[] | null> => {
      const box = await cdp.evaluate<{ x: number; y: number; w: number } | null>(`(() => {
        const tab = [...document.querySelectorAll('#controls button')]
          .find((b) => (b.textContent ?? '').trim() === 'Install');
        if (tab) tab.click();
        const rail = document.querySelector('#controls .sl .rail');
        if (!rail) return null;
        const r = rail.getBoundingClientRect();
        return { x: r.left, y: r.top + r.height / 2, w: r.width };
      })()`);
      if (!box) return null;
      const read = (): Promise<string> =>
        cdp.evaluate<string>(
          "document.querySelector('#controls .sl .val')?.textContent?.trim() ?? ''",
        );
      const x0 = box.x + box.w * 0.15;
      const x1 = box.x + box.w * 0.75;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: x0, y: box.y, button: 'left', buttons: 1, clickCount: 1,
        pointerType: 'mouse',
      });
      const seen: string[] = [];
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 6, y: box.y, button: 'left', buttons: 1,
          pointerType: 'mouse',
        });
        await sleep(90);
        seen.push(await read());
      }
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: x1, y: box.y, button: 'left', buttons: 0, clickCount: 1,
        pointerType: 'mouse',
      });
      await sleep(400);
      seen.push(await read());
      return seen;
    })();
    if (!dragged) {
      failures.push('found no slider to drag on the Install tab');
    } else {
      const distinct = new Set(dragged).size;
      if (distinct < 4) {
        failures.push(
          `dragging a slider produced ${distinct} distinct values across 6 steps ` +
            `(${dragged.join(', ')}) — the drag stops tracking the pointer`,
        );
      } else {
        process.stdout.write(
          `  slider drag tracked ${distinct} values (${dragged[0]} → ${dragged[dragged.length - 1]})\n`,
        );
      }
    }

    if (opts.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(opts.screenshot, Buffer.from(shot.data, 'base64'));
      process.stdout.write(`  screenshot: ${opts.screenshot}\n`);
    }

    // ---- and now the same page on a phone ---------------------------------
    //
    // This pass exists because the desktop one passed while the phone layout was
    // unusable: measured on a 390×844 screen the panels covered the canvas from
    // edge to edge — 0 visible pixels of room — and the readout was crushed into
    // 31 px. Every check above was green throughout. What follows asserts the
    // two things a phone visitor needs and a wide window never exercises: that
    // the room is visible between the sheets, and that a pinch zooms, since a
    // phone has no scroll wheel.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE_W,
      height: PHONE_H,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Page.navigate', { url: opts.url });
    await sleep(1200);
    for (let i = 0; i < 30; i++) {
      const lit = await cdp.evaluate<string>(
        "document.getElementById('view')?.dataset?.range ?? ''",
      );
      if (lit !== '') break;
      await sleep(500);
    }
    await cdp.evaluate("document.querySelector('[data-smoke=\"help-close\"]')?.click()");
    await sleep(400);

    const phone = await cdp.evaluate<{ band: number; collapsed: boolean; range: string }>(`(() => {
      const box = (id) => document.getElementById(id).getBoundingClientRect();
      return {
        band: Math.round(box('left').top - box('right').bottom),
        collapsed: document.getElementById('right').classList.contains('collapsed'),
        range: document.getElementById('view').dataset.range ?? '',
      };
    })()`);
    if (!phone.collapsed) {
      failures.push('the control panel opens over the room on a phone instead of collapsed');
    }
    if (phone.band < 180) {
      failures.push(
        `the room is ${phone.band} px tall between the panels on a ${PHONE_W}×${PHONE_H} screen — ` +
          'the picture this page is about has been covered up',
      );
    } else {
      process.stdout.write(`  phone: ${phone.band} px of room between the sheets\n`);
    }

    // Now open the settings, which is what a phone visitor does about ten seconds
    // in, and check the two things that used to be wrong at the same time: the
    // sheet had room for a tab row and half a slider, and the ball it was meant
    // to be controlling was behind the buttons.
    //
    // The sheet's cap used to reserve a flat 54vh for the readout column whether
    // the readout was on the screen or not, so with it collapsed to its 44px
    // button four hundred pixels were held for nothing. Reclaiming them is only
    // an improvement if the picture does not then go under the panel that
    // reclaimed them, which is what the camera's lens shift is for — hence both
    // halves of this check, not one.
    const tapPanel = `(() => {
      const b = [...document.querySelectorAll('#topbtns button')]
        .filter((x) => (x.textContent ?? '').trim() !== '?')[0];
      if (b) b.click();
      return !!b;
    })()`;
    const tapReadout = "document.querySelector('#leftbtns button')?.click()";
    /**
     * Where the sheets are, and where the ball actually is — off the CANVAS,
     * not off the settings, so this cannot pass by agreeing with itself.
     */
    const SHEETS = `(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      const right = box('#right');
      const left = box('#left');
      const c = document.getElementById('view');
      const off = document.createElement('canvas');
      off.width = 130; off.height = 280;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, off.width, off.height);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let first = -1, last = -1;
      for (let y = 0; y < off.height; y++) {
        for (let x = 0; x < off.width; x++) {
          const p = 4 * (y * off.width + x);
          const mx = Math.max(d[p], d[p + 1], d[p + 2]);
          const mn = Math.min(d[p], d[p + 1], d[p + 2]);
          // By COLOUR, not by brightness. Brightness finds the floor: it is a mid
          // grey and it runs down the middle of the frame, so a "the ball is the
          // bright thing" test reported the centre of the floor and this check
          // failed against a layout that was correct. The room is neutral —
          // grey floor, black ceiling, grey rail — and the map on the ball is
          // the only thing in the picture that is not.
          if (mx > 40 && mx - mn > 24) { if (first < 0) first = y; last = y; }
        }
      }
      const toPage = (i) => Math.round(((i + 0.5) / off.height) * window.innerHeight);
      return {
        controls: Math.round(box('#controls').height),
        top: Math.round(right.bottom),
        bottom: Math.round(left.top),
        ballTop: first < 0 ? -1 : toPage(first),
        ballBottom: last < 0 ? -1 : toPage(last),
      };
    })()`;
    type Sheets = {
      controls: number; top: number; bottom: number; ballTop: number; ballBottom: number;
    };

    /**
     * Take the measurement once the picture has caught up with the layout.
     *
     * Not a fixed sleep. This runs under a software rasteriser, where a
     * full-screen supersampled redraw at a phone's device pixel ratio is several
     * million fragments and takes the better part of a second — so a 900 ms wait
     * measured the ball where it was before the tap, and reported a layout that
     * was right as a layout that was wrong. Polling for two identical readings
     * asks the question the check is actually about: where did this end up.
     */
    const settled = async (): Promise<Sheets> => {
      let last = await cdp.evaluate<Sheets>(SHEETS);
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        const now = await cdp.evaluate<Sheets>(SHEETS);
        if (now.ballTop === last.ballTop && now.ballBottom === last.ballBottom) return now;
        last = now;
      }
      return last;
    };

    await cdp.evaluate(tapPanel);
    const withReadout = await settled();
    const band = withReadout.bottom - withReadout.top;
    if (band < 180) {
      failures.push(
        `with the settings open the room is ${band} px between the sheets — the sheet grew into ` +
          'the picture instead of into the space nothing was using',
      );
    } else if (withReadout.ballTop < 0) {
      failures.push('with the settings open there is no sphere down the middle of the screen');
    } else {
      // Centred in the ROOM, not in the window. The ball can be taller than the
      // band at a close framing and then it overlaps both sheets, which is the
      // best a band that size allows; what must never happen again is the ball
      // sitting at the middle of the WINDOW with its top behind the buttons.
      const ballMid = (withReadout.ballTop + withReadout.ballBottom) / 2;
      const roomMid = (withReadout.top + withReadout.bottom) / 2;
      if (Math.abs(ballMid - roomMid) > 24) {
        failures.push(
          `the sphere is centred at ${Math.round(ballMid)} px and the room the sheets left runs ` +
            `${withReadout.top}–${withReadout.bottom}, centred at ${Math.round(roomMid)}. The ` +
            "camera's lens shift is meant to put the picture where the room is.",
        );
      } else {
        process.stdout.write(
          `  phone: settings open, ball centred at ${Math.round(ballMid)} in the ` +
            `${withReadout.top}–${withReadout.bottom} room\n`,
        );
      }
    }

    // And with the readout put away — the state the sheet was starved in, because
    // the space it was starved of was the space the readout was not using.
    await cdp.evaluate(tapReadout);
    const alone = await settled();
    // 300px is a tab row, a chip row and two full sliders. Below that the sheet
    // is a viewport onto a control rather than a control.
    if (alone.controls < 300) {
      failures.push(
        `with the readout closed the settings sheet is still ${alone.controls} px tall on a ` +
          `${PHONE_W}×${PHONE_H} screen — it fits a tab row and half a slider, so every control ` +
          'is reached by scrolling a window smaller than the thing inside it',
      );
    } else {
      process.stdout.write(`  phone: readout closed, settings sheet ${alone.controls} px tall\n`);
    }
    // Put both back, so the pinch below happens on the layout it was written for.
    await cdp.evaluate(tapReadout);
    await cdp.evaluate(tapPanel);
    await sleep(600);

    // Two fingers, drawn apart, at the middle of that visible band.
    const midY = Math.round(PHONE_H / 2);
    const finger = (x: number, id: number): unknown => ({ x, y: midY, id, radiusX: 12, radiusY: 12, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [finger(150, 1), finger(240, 2)],
    });
    for (let i = 1; i <= 6; i++) {
      const half = 45 + i * 9;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [finger(195 - half, 1), finger(195 + half, 2)],
      });
      await sleep(60);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
    const pinched = await cdp.evaluate<string>("document.getElementById('view').dataset.range");
    const before = Number.parseFloat(phone.range);
    const after = Number.parseFloat(pinched);
    if (!(after < before - 0.05)) {
      failures.push(
        `a pinch did not zoom: the camera stayed at ${phone.range} m (now ${pinched} m). ` +
          'A phone has no scroll wheel, so this is the only way in.',
      );
    } else {
      process.stdout.write(`  phone: pinch moved the camera ${before.toFixed(1)} → ${after.toFixed(1)} m\n`);
    }

    for (const e of cdp.pageErrors) failures.push(`uncaught in the page: ${e.split('\n')[0]}`);
    for (const e of cdp.consoleErrors) failures.push(`console error: ${e.split('\n')[0]}`);

    cdp.close();
  } finally {
    child.kill('SIGKILL');
    // Chromium's own teardown races the delete and re-creates files under the
    // profile as it goes, so a single rm can fail with ENOTEMPTY on a directory
    // that is about to be empty. A temporary directory left behind is noise; a
    // crash here would report a passing check as a failure.
    if (!opts.keep) {
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200);
        }
      }
    }
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
