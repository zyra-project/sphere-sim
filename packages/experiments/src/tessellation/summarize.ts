// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Experiment 7's summarising half, which is everything the CLI decides and
 * nothing it writes.
 *
 * Separated from `cli.ts` so it can be TESTED, and separated for a specific
 * reason rather than tidiness. Experiment 6 computed its figures twice — once
 * for the results file, once for the terminal — and the two diverged the moment
 * a policy was added to one: the file dropped seeds whose solve never settled
 * and the report went on printing medians that still included them. The same
 * fault, in a third place, that `solveInstalled` and the page's drift cells had.
 * So here there is one producer, `summarize`, and everything else reads what it
 * returned. A test can then hold the POLICY — which seeds count — rather than
 * holding a number that happens to fall out of today's data.
 */

import type { Arm } from './design.ts';
import { ARMS, DOCUMENTED_SEEDS, SEED_COUNT } from './design.ts';
import type { PointRun } from './run.ts';
import { median, radiusDeficitMm, rigRadiusM, worst } from './run.ts';

/**
 * The control each arm's ratios are taken against.
 *
 * Chosen by whether the arm pinned lens shift, not hard-coded per arm: a
 * shift-known mesh arm compared against the FREE analytic floor would fold the
 * degeneracy's own removal into the number that is supposed to isolate the
 * derivative, and the whole point of those arms is that the floor moves with
 * them.
 */
const controlFor = (arm: Arm): string => (arm.shiftKnown === true ? 'analytic-shift-known' : 'analytic');

/**
 * The pairs that are mechanism tests: the same body and the same photographs
 * with the derivative swapped, and nothing else different.
 *
 * Hand-maintained beside `ARMS`, which is the arrangement that goes quietly
 * wrong: add a smooth arm, forget to pair it, and the one table that isolates
 * anything silently stops covering it. `tessellation.test.ts` walks `ARMS` and
 * fails if a smooth arm is unpaired or a pair's halves differ in anything but
 * the normal — the same guard `check:ci-parity` needed after it turned out to
 * be reading one workflow and calling that the set.
 */
export const MECHANISM: readonly { label: string; facet: string; smooth: string }[] = [
  { label: 'coarsest grid, shift free', facet: '64x128', smooth: '64x128-smooth' },
  { label: 'coarsest grid, shift at truth', facet: '64x128-shift-known', smooth: '64x128-smooth-shift-known' },
  { label: 'finest grid, shift free', facet: '192x384', smooth: '192x384-smooth' },
];

/**
 * One arm's figures at one scope, computed once and rendered wherever needed.
 *
 * Typed rather than left inline for the reason experiment 6 learned the hard
 * way: the results file and the terminal report both read it, and when they
 * were two independent passes a policy added to one left the other printing
 * figures the file no longer agreed with.
 */
export interface Summary {
  /**
   * `all-including-refused` exists to keep the drop policy HONEST.
   *
   * The policy below removes a seed where any arm failed to converge, because
   * the page refuses such a solve. But the smooth arms are the ones that stall —
   * `lambda`, an early exit the record measures reaching a LOWER cost than the
   * facet solve that converged — so excluding those seeds removes, selectively,
   * the rows where smooth behaves differently, which is a bias pointed at the
   * very comparison this experiment is for. Reporting the same figures with
   * nothing excluded costs one pass and lets a reader see whether the headline
   * is an artifact of the exclusion.
   */
  scope: 'documented' | 'all' | 'all-including-refused';
  arm: string;
  question: string;
  facets: number;
  /**
   * How far inside the photographed sphere this arm's facets sit, millimetres.
   *
   * Zero on the control, which IS the sphere. Set against the arm's position
   * error it says what fraction of any gap could be the bodies differing rather
   * than the derivative — see `radiusDeficitMm`.
   */
  bodyDeficitMeanMm: number;
  bodyDeficitMaxMm: number;
  shiftKnown: boolean;
  control: string;
  n: number;
  seedsDropped: number;
  medianPosMm: number;
  worstPosMm: number;
  medianRotDeg: number;
  worstRotDeg: number;
  medianResidualPx: number;
  medianIterations: number;
  medianSeconds: number;
  /** Over the scope's rows for this arm BEFORE the drop, so the reader sees who failed. */
  notConverged: number;
  /**
   * How the arm's solves stopped, counted by reason, over those same pre-drop
   * rows. A `lambda` count is the smooth mode's early exit and a `maxIterations`
   * count is the record's own defect; the drop policy hides both from the
   * medians, and this is where they stay visible.
   */
  stops: Record<string, number>;
  /**
   * The distinct gauge-constraint counts seen across this arm's rows, sorted.
   *
   * Summarised rather than left in the point log because a claim rests on it:
   * the record has spheroids PINNING and tri-axials FREEING, and if facets gave
   * the stiffness test something extra to bite on, a mesh arm would free where
   * the analytic control pins. Whether they agree is the evidence, so it has to
   * be somewhere a reader of the results file can see it. A single shared value
   * across every arm means the tessellation changed nothing the gauge can see.
   */
  gaugeConstraints: number[];
  /** This arm's medians over its control's. 1.00 on the control itself. */
  posVsControl: number;
  rotVsControl: number;
  /**
   * Residual against the control's.
   *
   * A-18's other half, and the reason the two ratios above cannot be read alone:
   * pose error that leaves for no change in residual means two calibrations far
   * apart fit the same photographs, which is a degeneracy; pose error that
   * leaves for a worse residual means a different and worse fit.
   */
  residualVsControl: number;
}

/** Memoised per grid: the same grids appear on several arms and in two scopes. */
const deficitCache = new Map<string, { mean: number; max: number }>();
function deficit(grid: { nLat: number; nLon: number }): { mean: number; max: number } {
  const k = `${grid.nLat}x${grid.nLon}`;
  const hit = deficitCache.get(k);
  if (hit !== undefined) return hit;
  const v = radiusDeficitMm(grid, rigRadiusM());
  deficitCache.set(k, v);
  return v;
}

/** How many points a complete run holds. Exported so the CLI states provenance. */
export const COMPLETE_POINTS = ARMS.length * (DOCUMENTED_SEEDS.length + SEED_COUNT);

export function summarize(runs: readonly PointRun[]): Summary[] {
    const summary: Summary[] = [];
  for (const scope of ['documented', 'all', 'all-including-refused'] as const) {
    const rows = scope === 'documented' ? runs.filter((r) => r.documented) : runs;

    // A SEED COUNTS ONLY IF EVERY ARM SETTLED ON IT, and neither half of that
    // is fastidiousness.
    //
    // Converged, because the page refuses a solve that stopped at its iteration
    // cap — `solveInstalled` in packages/web/src/display.ts — so a non-converged
    // endpoint is a calibration nobody would be allowed to install, and
    // averaging it in publishes a refused solve as the arm's result.
    //
    // Every arm, because every figure here is a RATIO — against a control, or
    // against the other normal on the same body. Letting an arm keep a seed its
    // partner lost would compare the two over different rigs and different
    // photons, which is the one thing the shared-archetype construction in
    // run.ts exists to rule out.
    const failed = new Set(rows.filter((r) => !r.converged).map((r) => r.seed));
    const usable = usableSeed(rows, scope);

    const controlStats = new Map<string, { pos: number; rot: number; resid: number }>();
    for (const name of new Set(ARMS.map(controlFor))) {
      const c = rows.filter((r) => r.arm === name && usable(r));
      if (c.length === 0) continue;
      controlStats.set(name, {
        pos: median(c.map((r) => r.posePositionMm)),
        rot: median(c.map((r) => r.poseRotationDeg)),
        resid: median(c.map((r) => r.residualRmsPx)),
      });
    }

    for (const arm of ARMS) {
      const all = rows.filter((r) => r.arm === arm.key);
      if (all.length === 0) continue;
      const kept = all.filter(usable);
      if (kept.length === 0) continue;
      const control = controlFor(arm);
      const c = controlStats.get(control);
      const pos = median(kept.map((r) => r.posePositionMm));
      const rot = median(kept.map((r) => r.poseRotationDeg));
      const resid = median(kept.map((r) => r.residualRmsPx));
      summary.push({
        scope,
        arm: arm.key,
        question: arm.question,
        facets: kept[0].facets,
        bodyDeficitMeanMm: arm.grid === null ? 0 : deficit(arm.grid).mean,
        bodyDeficitMaxMm: arm.grid === null ? 0 : deficit(arm.grid).max,
        shiftKnown: arm.shiftKnown === true,
        control,
        n: kept.length,
        // Only the rows a POLICY removed. `all.length - kept.length` also counts
        // rows sitting on a seed that has not finished every arm yet, and an
        // unfinished seed is not an exclusion anybody decided — reporting it as
        // one would have a half-run sweep announce a drop it never made. The
        // comment above `partial` already said so; this line did not.
        seedsDropped: scope === 'all-including-refused' ? 0 : all.filter((r) => failed.has(r.seed)).length,
        medianPosMm: pos,
        worstPosMm: worst(kept.map((r) => r.posePositionMm)),
        medianRotDeg: rot,
        worstRotDeg: worst(kept.map((r) => r.poseRotationDeg)),
        medianResidualPx: resid,
        medianIterations: median(kept.map((r) => r.iterations)),
        medianSeconds: median(kept.map((r) => r.seconds)),
        notConverged: all.filter((r) => !r.converged).length,
        gaugeConstraints: [...new Set(kept.map((r) => r.gaugeConstraints))].sort((a, b) => a - b),
        stops: all.reduce<Record<string, number>>((acc, r) => {
          acc[r.stopReason] = (acc[r.stopReason] ?? 0) + 1;
          return acc;
        }, {}),
        posVsControl: c === undefined ? NaN : pos / c.pos,
        rotVsControl: c === undefined ? NaN : rot / c.rot,
        residualVsControl: c === undefined ? NaN : resid / c.resid,
      });
    }
  }

  return summary;
}


export interface MechanismRow {
  label: string;
  facetArm: string;
  smoothArm: string;
  control: string;
  facetMedianPosMm: number;
  smoothMedianPosMm: number;
  controlMedianPosMm: number;
  /**
   * What fraction of the facet arm's EXCESS over its control the smooth normal
   * takes back — or null when there is no excess for that question to be about.
   *
   * The denominator is `facet - control`, and it goes to zero: with lens shift
   * pinned at truth the facet arm at 64x128 lands on the analytic floor to a
   * tenth of a millimetre, and a first draft of this field duly reported
   * -8484%. A ratio whose denominator vanishes does not become informative by
   * being printed; it becomes a number that looks like a finding.
   *
   * So it is reported only when the excess clears `EXCESS_FLOOR` of the
   * control, and otherwise null, which the renderers say out loud. A value
   * above 100 is not guarded and is not an error: it means the smooth arm
   * landed BELOW the control, which is a real thing to have found and one this
   * experiment did not expect.
   */
  posRecoveredPercent: number | null;
  facetMedianRotDeg: number;
  smoothMedianRotDeg: number;
  controlMedianRotDeg: number;
  rotRecoveredPercent: number | null;
  /**
   * Seeds where BOTH arms of the pair have a usable row. The n of the two tests
   * below, and never assumed equal to the seed count.
   */
  pairs: number;
  /** Seeds where the smooth arm's position error is the smaller of the two. */
  posSmoothWins: number;
  /** Seeds where the smooth arm's rotation error is the smaller of the two. */
  rotSmoothWins: number;
  /**
   * Two-sided sign test on those paired wins.
   *
   * The medians above are a comparison of two summaries; this is a comparison of
   * the seeds themselves, and with thirteen of them it is the statistic that can
   * tell an effect from a draw. The record settled the same question this way —
   * "smooth wins 152 of 180, sign test 3.7e-30" — and a median of thirteen
   * quoted without it would be exactly the kind of number this document has
   * twice had to retract for resting on three seeds.
   */
  posSignP: number;
  rotSignP: number;
  /**
   * The smooth arm's residual over the facet arm's.
   *
   * The number that decides what any recovery above MEANS. Two modes reaching
   * different poses at the same residual are two calibrations fitting the same
   * photographs, and then the normal chose a point along a degenerate direction
   * rather than fitting better.
   */
  smoothResidualOverFacet: number;
}

/**
 * How far above its control a facet arm must sit before "what fraction of the
 * excess did the normal recover" is a question with an answer.
 *
 * A tenth. Declared rather than tuned: the excesses this experiment is about are
 * factors, not percents, so any arm under a tenth above its control is at parity
 * and the ratio below is dividing by noise.
 */
export const EXCESS_FLOOR = 0.1;

/**
 * THE DROP POLICY, in one place, because there are two callers.
 *
 * `summarize` uses it for the medians and `pairUp` for the paired win counts,
 * and when those were two separate predicates the win counts were taken over a
 * looser set than the medians — a table whose two halves described different
 * populations while looking like one measurement. That is the same divergence
 * this module's docblock is about, reintroduced three functions below the
 * paragraph warning against it.
 *
 * A seed is usable when every arm present in the log has a row for it (an
 * unfinished seed is not a result) and, outside `all-including-refused`, when
 * every one of those rows converged (the page refuses a solve that did not, so
 * averaging one in publishes a calibration nobody could install).
 */
export function usableSeed(
  rows: readonly PointRun[],
  scope: Summary['scope'],
): (r: PointRun) => boolean {
  const present = new Map<number, number>();
  const failed = new Set<number>();
  for (const r of rows) {
    present.set(r.seed, (present.get(r.seed) ?? 0) + 1);
    if (!r.converged) failed.add(r.seed);
  }
  const armCount = new Set(rows.map((r) => r.arm)).size;
  const partial = new Set([...present].filter(([, c]) => c < armCount).map(([s]) => s));
  return (r: PointRun): boolean =>
    !partial.has(r.seed) && (scope === 'all-including-refused' || !failed.has(r.seed));
}

/**
 * The seeds where a pair's THREE arms — facet, smooth and their control — all
 * produced a row worth counting.
 *
 * Three arms, not ten, and that is the whole point of this function existing
 * separately from the arms table. The arms table takes ratios ACROSS every arm,
 * so it needs one seed set common to all of them; a seed any arm failed has to
 * go. On thirteen seeds and ten arms that rule cost SEVEN of them and left the
 * table at n=6 with no power to speak of — the sign tests came back at p=0.22
 * on splits of five in six.
 *
 * A mechanism pair is a comparison between two arms and a floor. Requiring the
 * other seven arms to have converged excludes seeds for the behaviour of arms
 * the comparison never looks at, which is loss with nothing bought. Restricting
 * the requirement to the three arms actually read keeps eleven, eleven and nine
 * — enough for the sign test to say something — and is no weaker a policy for
 * the rows it does report, because each of those rows is still a solve the page
 * would install.
 *
 * The cost is that this table and the arms table are over different seed sets.
 * That is stated rather than smoothed over: every median a mechanism row
 * reports is computed HERE, over these seeds, and never borrowed from the arms
 * table. A block whose medians came from one set and whose win counts came from
 * another would be the divergence this module exists to prevent.
 *
 * Seeds are matched, never zipped: two arrays filtered from the same log can
 * differ in length and in order the moment one arm is missing a point, and a
 * positional pairing would then compare one seed's smooth solve against
 * another's facet solve and call it a win.
 */
interface Triple {
  facet: PointRun;
  smooth: PointRun;
  control: PointRun;
}

function pairUp(
  runs: readonly PointRun[],
  facetArm: string,
  smoothArm: string,
  controlArm: string,
  scope: Summary['scope'],
): Triple[] {
  const rows = scope === 'documented' ? runs.filter((r) => r.documented) : runs;
  const wanted = [facetArm, smoothArm, controlArm];
  const bySeed = new Map<number, Map<string, PointRun>>();
  for (const r of rows) {
    if (!wanted.includes(r.arm)) continue;
    const slot = bySeed.get(r.seed) ?? new Map<string, PointRun>();
    slot.set(r.arm, r);
    bySeed.set(r.seed, slot);
  }
  const out: Triple[] = [];
  for (const slot of bySeed.values()) {
    const facet = slot.get(facetArm);
    const smooth = slot.get(smoothArm);
    const control = slot.get(controlArm);
    if (facet === undefined || smooth === undefined || control === undefined) continue;
    // A control that IS one of the pair (it never is, but the shape allows it)
    // must not be counted twice against the convergence rule.
    if (
      scope !== 'all-including-refused' &&
      [facet, smooth, control].some((r) => !r.converged)
    ) {
      continue;
    }
    out.push({ facet, smooth, control });
  }
  return out;
}

/**
 * Two-sided sign test: the chance of `wins` or a split at least this lopsided,
 * from `n` fair coins.
 *
 * Exact rather than normal-approximated, because `n` here is thirteen and the
 * approximation is worst exactly where the counts are small. Ties are excluded
 * by the caller, which is what a sign test requires.
 */
export function signTestP(wins: number, n: number): number {
  if (n === 0) return 1;
  const k = Math.max(wins, n - wins);
  let tail = 0;
  let c = 1;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * tail * Math.pow(0.5, n));
}

/** The recovered fraction, or null when the excess is too small to divide by. */
function recovered(facet: number, smooth: number, control: number): number | null {
  const excess = facet - control;
  if (!Number.isFinite(excess) || excess <= Math.abs(control) * EXCESS_FLOOR) return null;
  return ((facet - smooth) / excess) * 100;
}

export function mechanismRows(
  rows: readonly Summary[],
  /**
   * The point log. REQUIRED, because every figure in a mechanism row is computed
   * from it over that row's own paired seeds — not one of them is carried over
   * from `rows`, which is a different and stricter seed set.
   *
   * It was optional once, defaulting to empty, back when only the win counts
   * needed it. That default now produces a row of NaN medians and zero pairs,
   * so it is gone: a caller who cannot supply the runs cannot have a mechanism
   * row, which is better than being handed one that looks computed.
   */
  runs: readonly PointRun[],
): MechanismRow[] {
  const out: MechanismRow[] = [];
  for (const m of MECHANISM) {
    const f = rows.find((r) => r.arm === m.facet);
    const s = rows.find((r) => r.arm === m.smooth);
    if (f === undefined || s === undefined) continue;
    const paired = pairUp(runs, m.facet, m.smooth, f.control, f.scope);
    // EVERY median below is computed over `paired` and none is borrowed from
    // the arms table, whose seed set is stricter — see `pairUp`. Mixing the two
    // would give this block medians from one population and win counts from
    // another, which is the fault this module was split out to prevent.
    const facetPos = median(paired.map((p) => p.facet.posePositionMm));
    const smoothPos = median(paired.map((p) => p.smooth.posePositionMm));
    const controlPos = median(paired.map((p) => p.control.posePositionMm));
    const facetRot = median(paired.map((p) => p.facet.poseRotationDeg));
    const smoothRot = median(paired.map((p) => p.smooth.poseRotationDeg));
    const controlRot = median(paired.map((p) => p.control.poseRotationDeg));
    const posWins = paired.filter((p) => p.smooth.posePositionMm < p.facet.posePositionMm).length;
    const rotWins = paired.filter((p) => p.smooth.poseRotationDeg < p.facet.poseRotationDeg).length;
    out.push({
      label: m.label,
      facetArm: f.arm,
      smoothArm: s.arm,
      control: f.control,
      facetMedianPosMm: facetPos,
      smoothMedianPosMm: smoothPos,
      controlMedianPosMm: controlPos,
      posRecoveredPercent: recovered(facetPos, smoothPos, controlPos),
      facetMedianRotDeg: facetRot,
      smoothMedianRotDeg: smoothRot,
      controlMedianRotDeg: controlRot,
      rotRecoveredPercent: recovered(facetRot, smoothRot, controlRot),
      pairs: paired.length,
      posSmoothWins: posWins,
      rotSmoothWins: rotWins,
      posSignP: signTestP(
        posWins,
        paired.filter((p) => p.smooth.posePositionMm !== p.facet.posePositionMm).length,
      ),
      rotSignP: signTestP(
        rotWins,
        paired.filter((p) => p.smooth.poseRotationDeg !== p.facet.poseRotationDeg).length,
      ),
      smoothResidualOverFacet:
        median(paired.map((p) => p.smooth.residualRmsPx)) /
        median(paired.map((p) => p.facet.residualRmsPx)),
    });
  }
  return out;
}


/** One phrasing for the recovered fraction, including for the case with none. */
function takesBack(percent: number | null): string {
  if (percent === null) {
    return 'the facet arm is already at its control, so there is no excess to take back';
  }
  if (percent > 100) return `smooth takes back ${percent.toFixed(0)}% — it lands BELOW the control`;
  return `smooth takes back ${percent.toFixed(0)}% of the facet arm's excess`;
}

export function report(summary: Summary[], runs: readonly PointRun[]): void {
  // RENDERS what `assemble` computed; it does not recompute it.
  const out: string[] = [''];
  out.push('EXPERIMENT 7 — what a facet normal costs where the facets ARE the body', '');
  for (const scope of ['documented', 'all', 'all-including-refused'] as const) {
    const rows = summary.filter((r) => r.scope === scope);
    if (rows.length === 0) continue;
    out.push(
      `## ${
        scope === 'documented'
          ? 'bench seed 1 alone'
          : scope === 'all'
            ? 'all seeds, refused solves excluded — THE HEADLINE'
            : 'all seeds, NOTHING excluded — the same figures without the drop policy'
      }`,
      '',
      'arm                        facets  shift   median pos   vs ctl   median rot   vs ctl   ' +
        'median resid   vs ctl   iters      n  dropped  stops',
    );
    for (const r of rows) {
      out.push(
        `${r.arm.padEnd(26)} ${String(r.facets).padStart(6)} ` +
          `${(r.shiftKnown ? 'truth' : 'free').padStart(6)} ` +
          `${r.medianPosMm.toFixed(1).padStart(12)} ${`${r.posVsControl.toFixed(2)}x`.padStart(8)} ` +
          `${r.medianRotDeg.toFixed(4).padStart(12)} ${`${r.rotVsControl.toFixed(2)}x`.padStart(8)} ` +
          `${r.medianResidualPx.toFixed(4).padStart(14)} ` +
          `${`${r.residualVsControl.toFixed(3)}x`.padStart(8)} ` +
          `${r.medianIterations.toFixed(0).padStart(5)} ${String(r.n).padStart(6)} ` +
          `${String(r.seedsDropped).padStart(8)}  gauge ${r.gaugeConstraints.join('/')}  ` +
          Object.entries(r.stops)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}:${v}`)
            .join(' '),
      );
    }
    for (const m of mechanismRows(rows, runs)) {
      out.push(
        '',
        `MECHANISM — ${m.label} (control ${m.control})`,
        `  position  facet ${m.facetMedianPosMm.toFixed(1)} mm, smooth ${m.smoothMedianPosMm.toFixed(1)}, ` +
          `control ${m.controlMedianPosMm.toFixed(1)} → ${takesBack(m.posRecoveredPercent)}`,
        `  rotation  facet ${m.facetMedianRotDeg.toFixed(4)}°, smooth ${m.smoothMedianRotDeg.toFixed(4)}, ` +
          `control ${m.controlMedianRotDeg.toFixed(4)} → ${takesBack(m.rotRecoveredPercent)}`,
        `  paired    ${m.pairs} seeds: smooth wins position ${m.posSmoothWins}, ` +
          `rotation ${m.rotSmoothWins}  (sign test p ${m.posSignP.toExponential(1)} / ` +
          `${m.rotSignP.toExponential(1)})`,
        `  residual  smooth is ${m.smoothResidualOverFacet.toFixed(4)}x the facet arm's — ` +
          `${Math.abs(m.smoothResidualOverFacet - 1) < 0.002 ? 'the same fit, so any move above is along a degenerate direction' : 'a different fit'}`,
      );
    }
    const deepest = rows.reduce((a, r) => Math.max(a, r.bodyDeficitMaxMm), 0);
    out.push(
      '',
      `The control is the analytic SPHERE and a mesh arm photographs a body up to ${deepest.toFixed(2)} mm`,
      'inside it, so `vs ctl` is the representation AND the body and isolates neither. The',
      'MECHANISM blocks above are the clean comparison: one mesh, one set of photographs, two',
      'derivatives.',
    );
    const dropped = new Set(rows.map((r) => r.seedsDropped)).size === 1 ? rows[0].seedsDropped : -1;
    if (dropped > 0) {
      out.push(
        '',
        `${dropped} seed(s) excluded from every arm: one arm or another did not converge, and`,
        'the page would refuse that calibration, so averaging it in would publish a refused',
        'solve as a result. Per-arm failure counts are `notConverged` in experiment-7.json.',
      );
    }
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}


