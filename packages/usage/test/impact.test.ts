/**
 * The impact model.
 *
 * Nothing here asserts that the answer is right — nobody can, which is the whole
 * premise of the module. What these tests pin is that the model is internally
 * coherent and that its declared falsifiers are actually evaluated rather than
 * asserted in a comment:
 *
 *   F1  the three methods agree to within 2x  -> would make the wide band wrong
 *   F2  method B reproduces published per-query figures -> would make method A redundant
 *   F3  one term dominates so completely the rest are noise
 *   F4  water/carbon are narrower than energy -> would make them unit conversions
 *
 * Each is checked below against the real project's shape. Three of the four do
 * not trigger, and the fourth is the reported headline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSTANTS,
  bottomUpTerms,
  costAnchoredKwh,
  drawConstants,
  noCacheKwh,
  runImpact,
} from '../src/impact.ts';
import type { Draw, Work } from '../src/impact.ts';
import { makeRng } from '../src/montecarlo.ts';

/** The shape this project actually had, rounded. Keeps the tests about the model. */
const WORK: Work = {
  prefillTokens: 70_800_000,
  readTokens: 3_420_000_000,
  outputTokens: 7_700_000,
  contextOutputProduct: 2.1e12,
  requests: 15_650,
  dollars: 2472.86,
};

const draw = (seed = 1): Draw => drawConstants(makeRng(seed));

test('every declared constant carries a provenance class and a note', () => {
  // A constant without provenance is indistinguishable from a measurement, and
  // this module is mostly guesses. docs/PARAMETERS.md sets the same rule.
  for (const [name, c] of Object.entries(CONSTANTS)) {
    assert.ok(['PUB', 'IND', 'ASSUME'].includes(c.provenance), `${name} provenance`);
    assert.ok(c.note.length > 20, `${name} needs a note explaining the range`);
    assert.ok(c.low > 0 && c.high >= c.low, `${name} bounds`);
  }
});

test('the model is dominated by ASSUME, and says so', () => {
  const classes = Object.values(CONSTANTS).map((c) => c.provenance);
  const assumed = classes.filter((c) => c === 'ASSUME').length;
  assert.ok(assumed > classes.length / 2, 'if this ever flips, the report should stop hedging');
});

test('F1 does NOT trigger: the three methods disagree by more than 2x', () => {
  const r = runImpact(WORK, 20_000);
  const medians = r.methods.map((m) => m.kwh.p50);
  const spread = Math.max(...medians) / Math.min(...medians);
  assert.ok(spread > 2, `methods span only ${spread.toFixed(1)}x — the wide band would be unjustified`);
});

test('F2 does NOT trigger: method B runs well above the published per-query figures', () => {
  // If this ever passed, method A would be redundant and B should be reported alone.
  const r = runImpact(WORK, 20_000);
  assert.ok(
    r.shortQueryWhMedian > CONSTANTS.publishedWhPerQuery.high,
    `B predicts ${r.shortQueryWhMedian.toFixed(2)} Wh, within the published range — drop method A`,
  );
});

test('F3 does NOT trigger: no single term is the whole answer', () => {
  const r = runImpact(WORK, 20_000);
  const shares = Object.values(r.termShares);
  assert.ok(Math.max(...shares) < 0.9, 'one term dominating would make the others noise');
  const sum = shares.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'term shares must partition the energy');
});

test('F4 does NOT trigger: water and carbon are wider than energy, not narrower', () => {
  // They carry their own uncertainty on top of the energy uncertainty, so they
  // are separate findings rather than unit conversions.
  const r = runImpact(WORK, 20_000);
  const width = (b: { p10: number; p90: number }): number => b.p90 / b.p10;
  assert.ok(width(r.pooled.litres) > width(r.pooled.kwh));
  assert.ok(width(r.pooled.kgCo2eLocation) > width(r.pooled.kwh));
});

test('method A is a floor and method C a ceiling, as documented', () => {
  const r = runImpact(WORK, 20_000);
  const [a, b, c] = r.methods;
  assert.ok(a.kwh.p50 < b.kwh.p50, 'A should sit below B');
  assert.ok(c.kwh.p50 > b.kwh.p50, 'C should sit above B');
});

test('the pooled band spans the individual methods', () => {
  const r = runImpact(WORK, 20_000);
  const lowest = Math.min(...r.methods.map((m) => m.kwh.p50));
  const highest = Math.max(...r.methods.map((m) => m.kwh.p50));
  assert.ok(r.pooled.kwh.p10 < lowest);
  assert.ok(r.pooled.kwh.p90 > highest);
});

test('location-based carbon exceeds market-based', () => {
  // Market-based credits power purchase agreements, so it is the lower of the
  // two by construction. Reporting only it would flatter the result.
  const r = runImpact(WORK, 20_000);
  assert.ok(r.pooled.kgCo2eLocation.p50 > r.pooled.kgCo2eMarket.p50);
});

test('turning caching off costs more energy, not less', () => {
  const d = draw();
  assert.ok(noCacheKwh(WORK, d) > bottomUpTerms(WORK, d).prefill);
  const r = runImpact(WORK, 20_000);
  assert.ok(r.noCacheKwhMedian > r.methods[1].kwh.p50 * 5, 'the saving should be large');
});

test('cache reads are cheaper per token than prefilled tokens', () => {
  // The central physical claim of the model: a read skips the network entirely
  // and pays only in memory traffic. If this inverted, the caching finding dies.
  const d = draw();
  const readsOnly = bottomUpTerms(
    { ...WORK, prefillTokens: 0, contextOutputProduct: 0 }, d,
  );
  const prefillOnly = bottomUpTerms(
    { ...WORK, prefillTokens: WORK.readTokens, readTokens: 0, contextOutputProduct: 0 }, d,
  );
  assert.ok(readsOnly.staging < prefillOnly.prefill);
});

test('energy scales with the work, not with the number of requests', () => {
  const d = draw();
  const one = bottomUpTerms(WORK, d);
  const twice = bottomUpTerms(
    {
      ...WORK,
      prefillTokens: WORK.prefillTokens * 2,
      readTokens: WORK.readTokens * 2,
      outputTokens: WORK.outputTokens * 2,
      contextOutputProduct: WORK.contextOutputProduct * 2,
    },
    d,
  );
  for (const key of Object.keys(one) as (keyof typeof one)[]) {
    assert.ok(Math.abs(twice[key] / one[key] - 2) < 1e-9, `${key} should be linear in the work`);
  }
});

test('method C ignores token counts entirely', () => {
  // It is only independent evidence if it never touches them.
  const d = draw();
  const base = costAnchoredKwh(WORK, d);
  const scrambled = costAnchoredKwh(
    { ...WORK, prefillTokens: 1, readTokens: 1, outputTokens: 1, contextOutputProduct: 1 },
    d,
  );
  assert.equal(base, scrambled);
});

test('the report is reproducible from its seed', () => {
  const a = runImpact(WORK, 5_000, 4242);
  const b = runImpact(WORK, 5_000, 4242);
  assert.deepEqual(a.pooled, b.pooled);
  assert.notDeepEqual(runImpact(WORK, 5_000, 1).pooled, a.pooled);
});

test('zero work produces zero impact rather than NaN', () => {
  const empty: Work = {
    prefillTokens: 0, readTokens: 0, outputTokens: 0,
    contextOutputProduct: 0, requests: 0, dollars: 0,
  };
  const r = runImpact(empty, 2_000);
  assert.equal(r.pooled.kwh.p50, 0);
  assert.ok(Number.isFinite(r.pooled.litres.p50));
  assert.ok(Number.isFinite(r.pooled.kgCo2eLocation.p50));
});
