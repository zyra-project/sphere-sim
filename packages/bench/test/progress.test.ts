/**
 * The progress page.
 *
 * Four claims, and the page is worth nothing without all four:
 *
 *  1. **It generates from a fixture, with no network and no files.**
 *     `renderProgressPage` takes everything it needs as an argument and performs
 *     no I/O, so the page can be built on a machine with no internet, from a
 *     results file that came from somewhere else, and the tests can drive it
 *     without a hundred-second bench run.
 *  2. **The output reaches for nothing.** No `<script>`, no stylesheet link, no
 *     font, no image from a host. Every `src` and `href` is either a `data:`
 *     URI or an anchor in the page itself. A report that quietly needs the
 *     internet is a report that will be blank in the room where it matters.
 *  3. **The static reference asserts its properties FROM THE DATA IT PLOTS.**
 *     Not from a caption, not from a constant: the multiplicity claim is read
 *     off the same array the map is drawn from, and the four-lobed claim is
 *     recovered by counting minima in the boundary curve parsed back out of the
 *     rendered SVG path. A test that compared a hardcoded string would pass on a
 *     page whose plot had gone wrong.
 *  4. **The structure statistic can tell structure from noise.** Two synthetic
 *     residual sets — one isotropic Gaussian, one with a radial term — must come
 *     back with different verdicts, or the most diagnostic plot on the page has
 *     a decorative number beside it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_IMAGE_STORE,
  analyseResiduals,
  renderProgressPage,
} from '../src/progress.ts';
import type { ProgressInput, ResidualColumnsJson } from '../src/progress.ts';
import { analyseCoverageReference, buildCoverageReference, countLobes } from '../src/reference.ts';
import type { CoverageReference } from '../src/reference.ts';
import { dispersion } from '../src/results.ts';
import type { BenchResults, GateSummary, ScenarioJson } from '../src/results.ts';
import type { MetricResult } from '../../sim/src/metrics/index.ts';

// ---------------------------------------------------------------------------
// Fixtures — a results file small enough to read, shaped exactly like a real one
// ---------------------------------------------------------------------------

function metric(overrides: Partial<MetricResult> & { id: string }): MetricResult {
  return {
    label: overrides.label ?? overrides.id,
    value: 0.5,
    unit: 'mm',
    gate: {
      id: overrides.id,
      metric: overrides.label ?? overrides.id,
      max: 1,
      unit: 'mm',
      klass: 'ASSUME',
      phase: 'geometry',
      basis: 'fixture',
    },
    gateMax: 1,
    pass: true,
    scored: true,
    provisional: false,
    note: 'fixture metric',
    sampling: {
      scheme: 'fixture',
      description: 'fixture',
      count: 10,
      densityPerSr: null,
      convergence: null,
    },
    detail: { p95Mm: 0.7, maxMm: 0.9, overlapAreaFraction: 0.68 },
    ...overrides,
  };
}

/** A deterministic residual block: `n` points per projector, seeded by hand. */
function residualFixture(n: number, projectors: number, radial: number): ResidualColumnsJson {
  const cols: ResidualColumnsJson = {
    count: 0,
    projector: [],
    camera: [],
    u: [],
    v: [],
    du: [],
    dv: [],
  };
  let state = 12345;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const gauss = (): number => {
    const a = Math.max(1e-12, rand());
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * rand());
  };
  for (let p = 0; p < projectors; p++) {
    for (let i = 0; i < n; i++) {
      const u = rand() * 1920;
      const v = rand() * 1080;
      const dx = u - 960;
      const dy = v - 540;
      const r = Math.hypot(dx, dy);
      const rr = r / Math.hypot(960, 540);
      cols.projector.push(p);
      cols.camera.push(0);
      cols.u.push(u);
      cols.v.push(v);
      cols.du.push(gauss() * 0.2 + (radial * rr * rr * dx) / Math.max(r, 1e-9));
      cols.dv.push(gauss() * 0.2 + (radial * rr * rr * dy) / Math.max(r, 1e-9));
      cols.count++;
    }
  }
  return cols;
}

function scenario(id: string, overrides: Partial<ScenarioJson> = {}): ScenarioJson {
  return {
    index: 0,
    id,
    archetype: id === 's00-clean' ? 'clean' : 'nominal',
    question: 'fixture question',
    seed: 77,
    inputs: {
      projectorCount: 2,
      slots: [0, 1],
      distanceM: 5.18,
      projectorHeightM: 2.1844,
      centerHeightM: 2.1844,
      projectorRes: { x: 1920, y: 1080 },
      maskInterpretation: 'latitude',
      floorReferenceCount: 4,
      floorSigmaM: 0.003,
      cameras: { count: 3, res: { x: 320, y: 240 } },
      degradation: { ambient: 0.04 },
      injected: {
        centerHeightMm: 1,
        projectors: [
          { id: 'P1', azimuthDeg: 0.5 },
          { id: 'P2', azimuthDeg: -0.5 },
        ],
      },
    },
    capture: { framesRendered: 30, correspondences: 400 },
    solver: {
      converged: true,
      stopReason: 'step',
      iterations: 12,
      rmsResidualPx: 0.2,
      perProjectorRmsPx: [0.2, 0.2],
      correspondencesUsed: 400,
      correspondencesRejected: 3,
      gaugeFreeAxes: [false, false, true],
      centerHeightObserved: true,
      residuals: residualFixture(200, 2, 0),
    },
    recovery: {
      preAlignment: { maxPositionMm: 3, maxRotationDeg: 0.04 },
      postAlignment: { maxPositionMm: 2.4, maxRotationDeg: 0.03 },
      gauge: { angleDeg: 0.0001, unconstrainedAngleDeg: 0.03, freeAxes: [false, false, true] },
      centerHeight: { errorMm: 3.1, observed: true },
      intrinsics: { maxFovHDeg: 0.1, maxK1: 0.001, maxK2: 0.0001, maxShift: 0.001 },
    },
    metrics: [metric({ id: 'grid_displacement', value: 0.42 })],
    metricsPass: true,
    baseline: { pass: false, metrics: [metric({ id: 'grid_displacement', value: 4.2, pass: false })] },
    artifacts: {
      roomBefore: 'progress/data/fixture-room-before.png',
      roomAfter: 'progress/data/fixture-room-after.png',
      registration: 'progress/data/fixture-registration.png',
      cameraFrame: 'progress/data/fixture-camera.png',
    },
    error: null,
    timings: { totalMs: 1 },
    ...overrides,
  };
}

function gate(overrides: Partial<GateSummary> & { id: string }): GateSummary {
  return {
    metric: 'fixture gate',
    unit: 'mm',
    max: 1,
    klass: 'ASSUME',
    phase: 'geometry',
    basis: 'fixture',
    pass: true,
    scenariosScored: 2,
    scenariosFailed: 0,
    failedScenarios: [],
    worst: { scenario: 's00-clean', value: 0.42 },
    distribution: dispersion([0.42, 0.5]),
    scenariosNotMeasurable: [],
    dependsOnRecovery: true,
    provisional: false,
    advisory: false,
    attribution: null,
    ...overrides,
  };
}

function results(overrides: Partial<BenchResults> = {}): BenchResults {
  return {
    schema: 'sphere-sim/bench-results@1',
    volatile: ['env', 'scenarios[].timings'],
    env: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      gitCommit: 'abcdef1234567890',
      gitDirty: false,
      node: 'v22.0.0',
      platform: 'linux-x64',
      cpus: 4,
      durationMs: 1000,
      scenarioDurationsMs: [500, 500],
      argv: [],
    },
    run: {
      seed: 1234,
      scenarioCount: 2,
      preset: 'default',
      conventions: 'sphere-sim/conventions@2',
      parametersRev: 'PARAMETERS.md rev 2',
      outDir: 'progress/data',
    },
    gates: {
      pass: false,
      gates: [
        gate({
          id: 'grid_displacement',
          pass: false,
          scenariosFailed: 1,
          failedScenarios: ['s01-nominal'],
          distribution: dispersion([0.42, 4.2]),
          worst: { scenario: 's01-nominal', value: 4.2 },
          attribution: {
            scenario: 's01-nominal',
            method: 'counterfactual substitution',
            contributor: 'projector-position',
            explains: '91% of the 3.20 mm excess over the gate',
            explainedFraction: 0.91,
            allGroupsExplain: 0.99,
            byGroup: [
              { group: 'none', value: 4.2 },
              { group: 'projector-position', value: 1.1 },
              { group: 'all', value: 0.06 },
            ],
            note: 'fixture attribution',
          },
        }),
      ],
      unscored: [{ id: 'registration_error', reason: 'no §7 gate on registration error itself' }],
      waivers: [],
    },
    aggregate: {
      gridDisplacementMm: dispersion([0.42, 4.2]),
      poseMaxPositionMmAligned: dispersion([2.4, 3.1]),
      poseMaxRotationDegAligned: dispersion([0.03, 0.04]),
      centerHeightErrorMm: dispersion([3.1, 4.0]),
      offSphereFluxExcess: dispersion([0.001, 0.002]),
    },
    scenarios: [scenario('s00-clean'), scenario('s01-nominal', { index: 1 })],
    notes: ['fixture note'],
    ...overrides,
  };
}

function input(overrides: Partial<ProgressInput> = {}): ProgressInput {
  return {
    results: results(),
    images: EMPTY_IMAGE_STORE,
    rounds: null,
    reference: null,
    previous: null,
    experiments: [],
    generatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 + 2. Generates from a fixture; reaches for nothing
// ---------------------------------------------------------------------------

test('the page generates from a fixture, with no file system and no network', () => {
  const html = renderProgressPage(input());
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('sphere-sim — progress'));
  // Both scenarios, both gates, the attribution and the notes made it through.
  assert.ok(html.includes('s00-clean'));
  assert.ok(html.includes('s01-nominal'));
  assert.ok(html.includes('grid_displacement'));
  assert.ok(html.includes('fixture note'));
});

test('the page contains no external URL, no script and no remote asset', () => {
  const html = renderProgressPage(
    input({
      images: { get: () => 'data:image/png;base64,iVBORw0KGgo=' },
    }),
  );

  assert.equal(/https?:\/\//i.test(html), false, 'an absolute URL reached the page');
  assert.equal(/<script/i.test(html), false, 'a script tag reached the page');
  assert.equal(/<link\b/i.test(html), false, 'a link tag reached the page');
  assert.equal(/<iframe/i.test(html), false);
  assert.equal(/@import/i.test(html), false);
  // Every src and href is either an in-page anchor or an inline data: URI.
  for (const m of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
    const value = m[1];
    assert.ok(
      value.startsWith('#') || value.startsWith('data:'),
      `non-local reference in the page: ${value.slice(0, 60)}`,
    );
  }
  // `url(...)` in the CSS may only point inside the document (the colour-bar
  // gradient), never at a host.
  for (const m of html.matchAll(/url\(([^)]*)\)/g)) {
    assert.ok(m[1].startsWith('#'), `CSS url() left the document: ${m[1]}`);
  }
});

test('every residual is plotted, not a subsample', () => {
  const cols = residualFixture(300, 2, 0);
  const html = renderProgressPage(
    input({
      results: results({
        scenarios: [
          scenario('s00-clean', {
            solver: { ...(scenario('s00-clean').solver as Record<string, unknown>), residuals: cols },
          }),
        ],
      }),
    }),
  );
  const circles = [...html.matchAll(/<circle cx="[^"]*" cy="[^"]*" r="0.9"\/>/g)].length;
  // Each correspondence appears in both views: du/dv, and radial against radius.
  assert.equal(circles, 2 * cols.count);
});

test('a missing render is drawn as a hole rather than skipped', () => {
  const html = renderProgressPage(input());
  assert.ok(html.includes('room render not found'));
  assert.ok(html.includes('registration map PNG not found'));
});

// ---------------------------------------------------------------------------
// 3. The static reference, asserted from the data it plots
// ---------------------------------------------------------------------------

/** Small enough for a test, dense enough to resolve a 4-degree scallop. */
function testReference(): CoverageReference {
  return buildCoverageReference({
    width: 180,
    height: 90,
    boundarySamples: 180,
    generatedAt: '2026-01-01T00:00:00.000Z',
    gitCommit: 'testcommit',
  });
}

test('the reference data itself carries PARAMETERS.md §4.2 and §4.3', () => {
  const ref = testReference();

  // §4.2, read off the array the map is drawn from — not off a caption.
  let maxMultiplicity = 0;
  for (const v of ref.multiplicity) maxMultiplicity = Math.max(maxMultiplicity, v);
  assert.equal(maxMultiplicity, 2, 'overlap multiplicity exceeded 2 — PARAMETERS.md §4.2');
  assert.ok(ref.multiplicity.includes(2), 'no 2-way overlap at all: the seams have gone');
  assert.ok(ref.multiplicity.includes(0), 'nothing unlit: the polar region has gone');

  // §4.3, recovered by counting minima of the boundary curve.
  const lobes = countLobes(ref.boundary.northLatDeg);
  assert.equal(lobes.length, 4, 'the unlit polar region is not four-lobed');
  const step = 360 / ref.boundary.lonDeg.length;
  for (const i of lobes) {
    const lon = ref.boundary.lonDeg[i];
    // Nearest seam direction, circularly. The minimum can only be located to
    // the longitude sample spacing, so the tolerance is one step.
    const gap = Math.min(
      ...[45, 135, -45, -135].map((s) => 180 - Math.abs(Math.abs(lon - s) % 360 - 180)),
    );
    assert.ok(gap <= step, `a lobe sits at ${lon}°, ${gap}° from any seam direction`);
  }

  const min = Math.min(...ref.boundary.northLatDeg);
  const max = Math.max(...ref.boundary.northLatDeg);
  assert.ok(max - min > 1, `boundary is a circular cap (scallop depth ${max - min}°)`);
  // The meridian directions are sampled exactly on this grid; the seam ones sit
  // between two samples, so the minimum is located to within a sample spacing.
  assert.ok(Math.abs(max - ref.analytic.meridianLimitDeg) < 0.05);
  assert.ok(Math.abs(min - ref.analytic.seamLimitDeg) < 0.4);

  // The area lies strictly between the two caps its own latitudes cut. That
  // containment IS "scalloped, not circular", stated as arithmetic.
  assert.ok(ref.analytic.unlitFractionNorth > ref.analytic.capAboveMeridianLimit);
  assert.ok(ref.analytic.unlitFractionNorth < ref.analytic.capAboveSeamLimit);
});

test('the rendered reference section reports the claims its own plots carry', () => {
  const ref = testReference();
  const checks = analyseCoverageReference(ref);
  assert.equal(checks.pass, true, checks.checks.filter((x) => !x.pass).map((x) => x.observed).join('; '));

  const html = renderProgressPage(input({ reference: ref }));

  // The multiplicity map paints one rectangle per run. Only three fills may
  // appear, and none of them the impossible-value colour the palette reserves
  // for a multiplicity above 2.
  const mapSvg = /<svg[^>]*aria-label="overlap multiplicity over the sphere"[\s\S]*?<\/svg>/.exec(html);
  assert.ok(mapSvg !== null, 'the multiplicity map is not in the page');
  const fills = new Set([...mapSvg[0].matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(
    [...fills].sort(),
    ['var(--mult1)', 'var(--mult2)', 'var(--unlit)'],
    'the multiplicity map painted a value outside 0..2',
  );

  // The four-lobed claim, recovered from the PLOTTED curve: parse the boundary
  // path out of the unrolled profile and count its minima in latitude. The plot
  // maps latitude to y downwards, so a minimum in latitude is a maximum in y.
  const profileSvg = /<svg[^>]*aria-label="coverage boundary latitude against longitude"[\s\S]*?<\/svg>/.exec(
    html,
  );
  assert.ok(profileSvg !== null, 'the boundary profile is not in the page');
  const d = /<path class="boundary" d="([^"]+)"/.exec(profileSvg[0]);
  assert.ok(d !== null);
  const ys = d[1]
    .split(/[ML]/)
    .filter((s) => s.trim().length > 0)
    .map((s) => -Number(s.trim().split(/\s+/)[1]));
  assert.equal(ys.length, ref.boundary.lonDeg.length);
  assert.equal(countLobes(ys, 0.5).length, 4, 'the plotted curve does not show four lobes');

  // And the prose beside them says what a failure would look like.
  assert.ok(html.includes('What you should see, and what would be a bug'));
  assert.ok(html.includes('Maximum observed multiplicity is <strong>2</strong>'));
  assert.ok(/rendered once/.test(html));
});

test('the reference checks actually fail when the data is wrong', () => {
  // A check nobody has watched fail is not a check. Both of the properties the
  // reference exists to guard are broken here, one at a time.
  const threeWay = testReference();
  threeWay.multiplicity[threeWay.grid.width * 40 + 20] = 3;
  const a = analyseCoverageReference(threeWay);
  assert.equal(a.pass, false);
  assert.equal(a.checks.find((x) => x.id === 'multiplicity')?.pass, false);
  assert.equal(a.maxMultiplicity, 3);

  const circular = testReference();
  circular.boundary.northLatDeg = circular.boundary.northLatDeg.map(() => 80.403);
  const b = analyseCoverageReference(circular);
  assert.equal(b.pass, false);
  assert.equal(b.checks.find((x) => x.id === 'four-lobed')?.pass, false);
  assert.equal(b.scallopDepthDeg, 0);
});

test('the reference is not regenerated by rendering the page', () => {
  // The page reads the reference; it never computes one. Feeding it a reference
  // whose numbers are impossible must produce a page that SAYS SO rather than a
  // page that quietly recomputed a correct one.
  const broken = testReference();
  broken.multiplicity[0] = 4;
  const html = renderProgressPage(input({ reference: broken }));
  assert.ok(html.includes('FAIL'), 'a broken reference rendered as passing');
  assert.ok(html.includes('max multiplicity over'));
});

// ---------------------------------------------------------------------------
// 4. The structure statistic
// ---------------------------------------------------------------------------

test('the residual statistic tells radial structure from isotropic noise', () => {
  const noise = analyseResiduals(residualFixture(3000, 1, 0), 0, 1920, 1080);
  assert.ok(noise !== null);
  assert.equal(noise.verdict, 'noise', `pure noise read as ${noise.verdict}`);
  assert.ok(Math.abs(noise.radialStructureZ) < 3);
  // An isotropic cloud must not be reported as anisotropic.
  assert.ok(noise.anisotropy < 1.15, `isotropic cloud read as ${noise.anisotropy}`);
  assert.ok(Math.abs(noise.axisAlignedZ) < 4);

  const structured = analyseResiduals(residualFixture(3000, 1, 0.6), 0, 1920, 1080);
  assert.ok(structured !== null);
  assert.equal(structured.verdict, 'structured', `a radial term read as ${structured.verdict}`);
  assert.ok(structured.radialStructureZ > 10);
  // The radial profile the panel draws must climb with radius, which is the
  // picture of the same statistic.
  const first = structured.bins[0].mean;
  const last = structured.bins[structured.bins.length - 1].mean;
  assert.ok(last > first + 0.2, `the plotted profile is flat: ${first} to ${last}`);
});

test('the anisotropy statistic recovers a known stretch', () => {
  const cols = residualFixture(2000, 1, 0);
  // Stretch du by 3. `patterns.ts` produces exactly this shape by counting Gray
  // planes once for both axes, and the panel prints the raster aspect ratio as
  // the value that means "decode, not model".
  for (let i = 0; i < cols.count; i++) cols.du[i] *= 3;
  const stats = analyseResiduals(cols, 0, 1920, 1080);
  assert.ok(stats !== null);
  assert.ok(Math.abs(stats.anisotropy - 3) < 0.25, `anisotropy read ${stats.anisotropy}, expected 3`);
  assert.ok(Math.abs(stats.majorAxisDeg) < 5, 'the major axis should lie along +u');
  assert.ok(Math.abs(stats.anisotropyExpected - 1920 / 1080) < 1e-9);
});

// ---------------------------------------------------------------------------
// The PROVISIONAL mechanism
// ---------------------------------------------------------------------------

test('a provisional metric lands in the provisional block, and only there', () => {
  const withProvisional = results();
  withProvisional.scenarios[0].metrics = [
    metric({ id: 'grid_displacement', value: 0.42 }),
    metric({
      id: 'seam_chromaticity',
      label: 'Seam chromaticity discontinuity',
      value: 0.8,
      unit: 'dE2000',
      provisional: true,
      note: 'depends on gamma_R,G,B which nobody has measured',
    }),
  ];
  const html = renderProgressPage(input({ results: withProvisional }));

  assert.ok(html.includes('PROVISIONAL'));
  assert.ok(html.includes('seam_chromaticity'));
  assert.ok(html.includes('depends on gamma_R,G,B which nobody has measured'));

  // It appears inside the provisional section and nowhere else on the page: a
  // provisional number loose in the gate table would borrow the credibility of
  // a measured one, which is the exact thing the phase gate forbids.
  const start = html.indexOf('id="provisional"');
  const end = html.indexOf('</section>', start);
  const outside = html.slice(0, start) + html.slice(end);
  assert.equal(outside.includes('seam_chromaticity'), false);
});

test('with no provisional metric the block is present, empty and explains itself', () => {
  const html = renderProgressPage(input());
  assert.ok(html.includes('none yet — the mechanism is live'));
  assert.ok(html.includes('provisional empty'));
  assert.ok(html.includes('This run contains none.'));
});

// ---------------------------------------------------------------------------
// Gates, experiments, trend
// ---------------------------------------------------------------------------

test('a failing gate names its single largest contributor', () => {
  const html = renderProgressPage(input());
  assert.ok(html.includes('Largest contributor: projector-position'));
  assert.ok(html.includes('91% of the 3.20 mm excess over the gate'));

  // Dispersion, never a bare mean: the corpus is bimodal by construction, so
  // every one of the five must be printed and the mean must not be.
  const section = html.slice(html.indexOf('id="gates"'), html.indexOf('id="residuals"'));
  for (const label of ['min ', 'p05 ', 'median ', 'p95 ', 'max ']) {
    assert.ok(section.includes(label), `the gate table omits ${label.trim()}`);
  }
  assert.equal(
    /mean\s+[-\d]/.test(section),
    false,
    'a mean was printed as a gate statistic',
  );
});

test('the experiment placeholders are present until their reports exist', () => {
  const html = renderProgressPage(input());
  assert.ok(html.includes('Experiment 1'));
  assert.ok(html.includes('Experiment 2'));
  assert.ok(html.includes('Experiment 3'));
  assert.equal([...html.matchAll(/not yet run/g)].length, 3);

  const filled = renderProgressPage(
    input({
      experiments: [
        {
          id: 'experiment-1-cameras',
          finding: 'Three photographs recover most of what eight do.',
          xLabel: 'cameras',
          yLabel: 'grid displacement (mm)',
          series: [{ label: 'nominal', x: [1, 2, 3], y: [8, 3, 1] }],
        },
      ],
    }),
  );
  assert.ok(filled.includes('Three photographs recover most of what eight do.'));
  assert.equal([...filled.matchAll(/not yet run/g)].length, 2);
});

test('the trend section says so when there is no history to trend', () => {
  const html = renderProgressPage(input());
  assert.ok(html.includes('No round history'));

  const withRounds = renderProgressPage(
    input({
      rounds: {
        schema: 'sphere-sim/rounds@2',
        rootSeed: 1,
        best: {
          round: 0,
          seed: 5,
          series: {
            gridDisplacementMm: {
              median: 0.9,
              p95: 4,
              max: 5,
              dispersion: 0.2,
              gateMax: 1,
              gateFraction: 0.9,
            },
          },
        },
        rounds: [
          {
            round: 0,
            seed: 5,
            at: '2026-01-01T00:00:00.000Z',
            preset: 'default',
            scenarioCount: 2,
            gitCommit: 'aaaaaaaa',
            pass: false,
            gates: [],
            series: {
              gridDisplacementMm: {
                median: 0.9,
                p95: 4,
                max: 5,
                dispersion: 0.2,
                gateMax: 1,
                gateFraction: 0.9,
              },
            },
            movement: { gridDisplacementMm: 'flat' },
            regressed: [],
            improving: false,
            consecutiveNonImproving: 1,
            comparison: {
              verdict: 'better',
              improved: [],
              regressed: [],
              why: 'first round on record: nothing to compare against, so it is the best by default.',
            },
            resultsPath: 'progress/data/round-000.json',
            best: true,
          },
        ],
      },
    }),
  );
  assert.ok(withRounds.includes('This history is at round 0'));
  assert.equal(withRounds.includes('No round history'), false);
});
