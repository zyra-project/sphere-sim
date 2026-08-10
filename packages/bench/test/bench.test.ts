/**
 * The bench, end to end.
 *
 * Three claims, and the whole project leans on all three:
 *
 *  1. Two runs with the same seed produce identical JSON and identical PNG
 *     bytes. A quality bar that moves between runs cannot detect a regression
 *     smaller than its own noise, and every number the loop compares would be
 *     measuring scheduling.
 *  2. A zero-misalignment scenario recovers a near-zero pose error. This is the
 *     canary for the entire path — rig construction, pattern generation,
 *     rendering, decode, bootstrap, bundle, gauge alignment, scoring. If any
 *     link is wired wrong the number is large, and nothing downstream of it
 *     means anything.
 *  3. `tools/assert-deterministic.ts` actually fails when it should. A check
 *     nobody has watched fail is not a check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { CliOptions } from '../src/cli.ts';
import { runBench } from '../src/cli.ts';
import { stringifyResults } from '../src/results.ts';
import { PRESETS } from '../src/scenarios.ts';
import type { BenchPreset } from '../src/scenarios.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A preset sized for a test rather than for a result.
 *
 * 160x120 cameras resolve the sphere at about 17 mm per pixel, which is far
 * coarser than anything worth quoting — the point here is that the path is
 * wired, not what it recovers. `--quick` is the smallest preset whose numbers
 * are worth looking at, and even those are marked as a plumbing check.
 */
const TEST_PRESET: BenchPreset = {
  ...PRESETS.quick,
  scenarioCount: 2,
  cameraResX: 160,
  cameraResY: 120,
  metricDensityScale: 0.15,
  metricConvergence: false,
  maxCorrespondencesPerPair: 600,
  renderSize: 128,
};

function optionsIn(dir: string, overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    seed: 20250101,
    scenarios: 2,
    out: path.join(dir, 'bench-results.json'),
    outDir: dir,
    preset: TEST_PRESET,
    artifacts: true,
    baseline: false,
    attribute: false,
    quiet: true,
    ...overrides,
  };
}

function tmpdir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sphere-bench-${tag}-`));
}

/** The two paths the schema declares volatile, removed the same way the tool does. */
function stripVolatile(text: string): string {
  const doc = JSON.parse(text) as Record<string, unknown> & { scenarios?: Record<string, unknown>[] };
  delete doc.env;
  for (const s of doc.scenarios ?? []) delete s.timings;
  return stringifyResults(doc);
}

test('two runs with the same seed produce identical JSON and identical PNGs', { timeout: 600_000 }, () => {
  // ONE directory, run twice. The output directory is a recorded input, so two
  // different temp directories would legitimately produce two different
  // documents and the comparison would be testing the test. Reading the PNGs
  // between the runs is what lets the second overwrite them safely.
  const dir = tmpdir('det');

  // Different `--out` filenames, same `--out-dir`, exactly as CI does it:
  // `bench-results.json` then `bench-results-2.json`. That asymmetry is not
  // incidental — it is what caught the output filename leaking into the
  // compared surface via a recorded `argv`, which would have failed CI's
  // determinism step on every commit for a reason that had nothing to do with
  // determinism.
  const a = runBench(optionsIn(dir, { out: path.join(dir, 'first.json') }));
  const readPngs = (): Map<string, Buffer> => {
    const out = new Map<string, Buffer>();
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort()) {
      out.set(name, fs.readFileSync(path.join(dir, name)));
    }
    return out;
  };
  const pngsA = readPngs();
  const b = runBench(optionsIn(dir, { out: path.join(dir, 'second.json') }));
  const pngsB = readPngs();

  const textA = stringifyResults(a);
  const textB = stringifyResults(b);
  // The whole documents differ, because `env` carries a wall clock. Everything
  // else must not.
  assert.notEqual(textA, textB, 'env should differ between runs; it carries a timestamp');
  assert.equal(stripVolatile(textA), stripVolatile(textB));

  // And the images. A PNG is the artifact a critic looks at, so byte equality
  // there is a separate claim from byte equality in the JSON: the encoder pins
  // its filter and its compression level precisely so this can hold.
  assert.ok(pngsA.size >= 6, `expected artifacts, found ${pngsA.size}`);
  assert.deepEqual([...pngsA.keys()], [...pngsB.keys()]);
  for (const [name, bytes] of pngsA) {
    assert.ok(bytes.equals(pngsB.get(name) as Buffer), `${name} differs between runs`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('assert-deterministic passes on a matching pair and fails on a doctored one', { timeout: 600_000 }, () => {
  const dir = tmpdir('tool');
  const a = runBench(optionsIn(dir, { scenarios: 1 }));
  const b = runBench(optionsIn(dir, { scenarios: 1 }));
  const fileA = path.join(dir, 'a.json');
  const fileB = path.join(dir, 'b.json');
  const fileC = path.join(dir, 'c.json');
  fs.writeFileSync(fileA, stringifyResults(a));
  fs.writeFileSync(fileB, stringifyResults(b));

  const tool = path.join(REPO_ROOT, 'tools', 'assert-deterministic.ts');
  const out = execFileSync('node', [tool, fileA, fileB], { encoding: 'utf8' });
  assert.match(out, /agree on every field|byte-identical/);

  // Doctor one number the volatile list does not cover. The tool must notice,
  // and must say WHERE — a determinism failure that only reports "files differ"
  // costs an afternoon.
  const doctored = JSON.parse(stringifyResults(b)) as {
    aggregate: Record<string, { median: number }>;
  };
  doctored.aggregate.gridDisplacementMm.median += 1e-9;
  fs.writeFileSync(fileC, stringifyResults(doctored));
  let failed = false;
  try {
    execFileSync('node', [tool, fileA, fileC], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    failed = true;
    const stderr = String((e as { stderr?: Buffer }).stderr ?? '');
    assert.match(stderr, /aggregate\.gridDisplacementMm\.median/);
  }
  assert.ok(failed, 'the tool accepted a doctored file');

  // And a file whose volatile declaration has been widened must be rejected
  // outright, whatever it contains — that is the check on the check.
  const widened = JSON.parse(stringifyResults(b)) as { volatile: string[] };
  widened.volatile = ['env', 'scenarios[].timings', 'aggregate'];
  fs.writeFileSync(fileC, stringifyResults(widened));
  let rejected = false;
  try {
    execFileSync('node', [tool, fileA, fileC], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, 'the tool accepted a widened volatile list');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a zero-misalignment scenario recovers a near-zero pose error', { timeout: 600_000 }, () => {
  const dir = tmpdir('canary');
  // The `clean` archetype at the smallest preset whose numbers mean anything:
  // zero injected misalignment, no ambient, no sensor noise, a static camera.
  const results = runBench({
    seed: 20250101,
    scenarios: 1,
    out: path.join(dir, 'r.json'),
    outDir: dir,
    preset: PRESETS.quick,
    artifacts: false,
    baseline: true,
    attribute: false,
    quiet: true,
  });

  const s = results.scenarios[0];
  assert.equal(s.archetype, 'clean');
  assert.equal(s.error, null);
  const recovery = s.recovery as {
    postAlignment: {
      maxPositionMm: number;
      maxRotationDeg: number;
      perProjector: { dxMm: number; dyMm: number; dzMm: number }[];
    };
    intrinsics: { maxFovHDeg: number; maxK1: number };
    centerHeight: { errorMm: number };
    gauge: { angleDeg: number };
  };

  // The rig here is EXACTLY the documented one, so every recovered number has a
  // known right answer of zero.
  //
  // The horizontal and vertical thresholds differ by a factor of five, and that
  // is the finding rather than a fudge. Horizontally the solve is pinned by the
  // images alone and lands sub-millimetre. Vertically it is pinned by the floor
  // references — PARAMETERS.md §8 item 1's tape measure, which this corpus gives
  // a 3 mm sigma — and the recovered rig inherits that as a small tilt about a
  // horizontal axis. No amount of solver work removes it; a better tape measure
  // does. Asserting them separately is what keeps that visible instead of
  // averaging it into one forgiving number.
  let worstHorizontal = 0;
  let worstVertical = 0;
  for (const p of recovery.postAlignment.perProjector) {
    worstHorizontal = Math.max(worstHorizontal, Math.hypot(p.dxMm, p.dyMm));
    worstVertical = Math.max(worstVertical, Math.abs(p.dzMm));
  }
  assert.ok(worstHorizontal < 3, `horizontal ${worstHorizontal} mm`);
  assert.ok(worstVertical < 15, `vertical ${worstVertical} mm`);
  assert.ok(recovery.postAlignment.maxPositionMm < 15, `position ${recovery.postAlignment.maxPositionMm} mm`);
  assert.ok(recovery.postAlignment.maxRotationDeg < 0.2, `rotation ${recovery.postAlignment.maxRotationDeg} deg`);
  assert.ok(recovery.intrinsics.maxFovHDeg < 0.01, `fov ${recovery.intrinsics.maxFovHDeg} deg`);
  assert.ok(recovery.intrinsics.maxK1 < 1e-4, `k1 ${recovery.intrinsics.maxK1}`);
  assert.ok(recovery.centerHeight.errorMm < 10, `h_center ${recovery.centerHeight.errorMm} mm`);

  const solver = s.solver as { converged: boolean; rmsResidualPx: number; stopReason: string };
  // Not `converged === true`. On a noiseless canary the fit reaches a residual
  // of order 1e-4 projector pixels, which is below the solver's own step and
  // gradient tolerances expressed in pixels, so Marquardt damping runs away
  // before either tolerance can fire and the honest `stopReason` is `lambda`.
  // That is the optimiser refusing to call a stall a convergence — exactly what
  // `packages/solver` says it does — and demanding the flag here would be
  // demanding it lie. The residual is the claim; the flag is the diagnosis.
  assert.ok(solver.rmsResidualPx < 0.05, `residual ${solver.rmsResidualPx} px`);
  assert.ok(
    solver.converged || solver.stopReason === 'lambda',
    `stopped for ${solver.stopReason} at ${solver.rmsResidualPx} px`,
  );

  // The contrast that makes the numbers above mean something: the same rig
  // scored against the DOCUMENTED calibration instead of the recovered one.
  const grid = s.metrics.find((m) => m.id === 'grid_displacement');
  const gridBaseline = s.baseline?.metrics.find((m) => m.id === 'grid_displacement');
  assert.ok(grid !== undefined && gridBaseline !== undefined);
  assert.ok(
    gridBaseline.value > 20 * grid.value,
    `solving bought only ${gridBaseline.value} -> ${grid.value} mm`,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
