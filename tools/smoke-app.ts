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
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('#inspect .seg button')]
        .find((x) => /Warp mesh/.test(x.textContent ?? ''));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(200);

    // The warp mesh is the one diagram computed by composing the two rigs, and a
    // flex column will happily squash an SVG to nothing while its caption goes on
    // claiming a picture is there — which is what it did. Check it has height.
    const mesh = await cdp.evaluate<{ h: number; grey: number; tinted: number } | null>(`(() => {
      const svg = document.querySelector('#inspect svg');
      if (!svg) return null;
      const groups = [...svg.querySelectorAll('g')];
      const count = (i) => groups[i] ? groups[i].querySelectorAll('polyline').length : 0;
      return { h: Math.round(svg.getBoundingClientRect().height), grey: count(0), tinted: count(1) };
    })()`);
    if (!mesh) {
      failures.push('the selected projector shows no warp mesh');
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
