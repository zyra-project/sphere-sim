/**
 * The page.
 *
 * Same three assertions packages/experiments/test/plot.test.ts makes about its
 * figures, for the same reason: a page separated from its source has nothing but
 * itself to carry the warning.
 *
 *  1. The SVG is well-formed. There is no XML parser in the Node standard
 *     library, so this file carries a small one.
 *  2. No NaN, undefined, or Infinity reaches a coordinate. An empty ledger is a
 *     real input — the model divides by sample counts — and a polyline with
 *     NaN in it silently disappears rather than failing.
 *  3. The word PROVISIONAL is on the face of the report. The environmental half
 *     is modelled, and a reader who takes it as measured has been misled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReport } from '../src/report.ts';
import { priceLedger } from '../src/cost.ts';
import { runImpact } from '../src/impact.ts';
import { repoUrl } from '../src/cli.ts';
import type { Work } from '../src/impact.ts';
import type { Ledger } from '../src/transcripts.ts';
import { zeroTokens } from '../src/transcripts.ts';

function ledger(overrides: Partial<Ledger> = {}): Ledger {
  const total = { uncached: 130, write1h: 34e6, write5m: 36e6, read: 3.4e9, output: 7.7e6 };
  return {
    total,
    byBucket: { main: total, subagent: zeroTokens(), workflow: zeroTokens() },
    messages: { main: 15_000, subagent: 250, workflow: 400 },
    agents: { subagent: 4, workflow: 411 },
    rawLines: 53_000,
    uniqueMessages: 15_650,
    files: 843,
    activeDays: 11,
    firstAt: '2026-08-10T00:00:00Z',
    lastAt: '2026-08-23T00:00:00Z',
    contextOutputProduct: 2.1e12,
    ...overrides,
  };
}

function build(l: Ledger): string {
  const cost = priceLedger(l, 'claude-opus-5');
  const work: Work = {
    prefillTokens: l.total.uncached + l.total.write1h + l.total.write5m,
    readTokens: l.total.read,
    outputTokens: l.total.output,
    contextOutputProduct: l.contextOutputProduct,
    requests: l.uniqueMessages,
    dollars: cost.total,
  };
  return renderReport({ ledger: l, cost, impact: runImpact(work, 3_000) });
}

/** Minimal well-formedness check: tags balance and attributes are quoted. */
function assertWellFormed(xml: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml)) !== null) {
    assert.equal(m.index, cursor, `unparsed markup at ${cursor}: ${xml.slice(cursor, cursor + 60)}`);
    cursor = tag.lastIndex;
    const [, closing, name, , selfClosing] = m;
    if (closing === '/') {
      assert.equal(stack.pop(), name, `mismatched </${name}>`);
    } else if (selfClosing !== '/') {
      stack.push(name);
    }
    // Text between tags is fine; skip to the next '<'.
    const next = xml.indexOf('<', cursor);
    if (next < 0) break;
    cursor = next;
    tag.lastIndex = next;
  }
  assert.deepEqual(stack, [], `unclosed: ${stack.join(', ')}`);
}

function svgOf(html: string): string {
  const start = html.indexOf('<svg');
  const end = html.indexOf('</svg>');
  assert.ok(start >= 0 && end > start, 'the report should contain a chart');
  return html.slice(start, end + '</svg>'.length);
}

test('the chart is well-formed XML', () => {
  assertWellFormed(svgOf(build(ledger())));
});

test('no NaN, undefined, or Infinity reaches a coordinate', () => {
  const svg = svgOf(build(ledger()));
  for (const bad of ['NaN', 'undefined', 'Infinity']) {
    assert.ok(!svg.includes(bad), `"${bad}" in the chart`);
  }
});

test('PROVISIONAL is on the face of the report', () => {
  assert.ok(build(ledger()).includes('PROVISIONAL'));
});

test('the measured half and the modelled half are labelled differently', () => {
  const html = build(ledger());
  assert.ok(/Cost\s*&mdash;\s*measured/.test(html));
  assert.ok(/Impact\s*&mdash;\s*provisional/.test(html));
});

test('an empty ledger still renders without NaN', () => {
  // The model divides by sample counts and by the short-query prediction; an
  // all-zero project must not put NaN on the page.
  const html = build(
    ledger({
      total: zeroTokens(),
      byBucket: { main: zeroTokens(), subagent: zeroTokens(), workflow: zeroTokens() },
      contextOutputProduct: 0,
      uniqueMessages: 0,
    }),
  );
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
});

test('every median is direct-labelled, since a static page has no hover layer', () => {
  const svg = svgOf(build(ledger()));
  // Three method medians plus the pooled one. Axis ticks are centre-anchored;
  // the value labels are not, so counting the non-centred monospace texts
  // isolates them.
  const values = (svg.match(/<text (?![^>]*text-anchor)[^>]*ui-monospace[^>]*>[\d,]+<\/text>/g) ?? []);
  assert.ok(values.length >= 4, `expected 4 direct labels, found ${values.length}`);
});

test('a timestamp carrying markup cannot inject into the page', () => {
  // firstAt/lastAt come straight from transcript JSON, and --root can point at a
  // tree this machine did not write. Slicing to ten characters is not a defence:
  // both values land in the same text run, so twenty attacker-controlled
  // characters share one tag context.
  const evil = '<img src=x onerror=alert(1)>';
  const html = build(ledger({ firstAt: evil, lastAt: evil }));
  assert.ok(!html.includes('<img src=x'), 'raw markup reached the page');
  assert.ok(html.includes('&lt;img'), 'the value should still be shown, escaped');
});

test('a ledger with no timestamps renders a dash, not the word undefined', () => {
  const html = build(ledger({ firstAt: null, lastAt: null }));
  assert.ok(!html.includes('undefined'));
  assert.match(html, /—\s*to\s*—/);
});

test('a model id with markup in it cannot inject into the page', () => {
  const l = ledger();
  const cost = priceLedger(l, 'claude-opus-5');
  const work: Work = {
    prefillTokens: 1, readTokens: 1, outputTokens: 1,
    contextOutputProduct: 1, requests: 1, dollars: 1,
  };
  const html = renderReport({
    ledger: l,
    cost: { ...cost, modelId: '<script>alert(1)</script>' },
    impact: runImpact(work, 500),
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a git remote becomes a browsable https link, in both remote forms', () => {
  assert.equal(repoUrl('https://github.com/o/r.git'), 'https://github.com/o/r');
  assert.equal(repoUrl('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(repoUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
  assert.equal(repoUrl('ssh://git@gitlab.com/group/sub/r.git'), 'https://gitlab.com/group/sub/r');
});

test('a remote that is not a plain http(s) URL never becomes a link', () => {
  // A git remote is arbitrary text and this value ends up in an href, so the
  // guard is load-bearing rather than defensive.
  for (const hostile of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    '/srv/local/repo.git',
    'https://evil.com/" onmouseover="alert(1)',
    'https://github.com/<script>',
    '',
  ]) {
    assert.equal(repoUrl(hostile), null, hostile);
  }
  assert.equal(repoUrl(undefined), null);
});

test('the link renders near the top and is escaped', () => {
  const html = renderReport({
    ledger: ledger(),
    cost: priceLedger(ledger(), 'claude-opus-5'),
    impact: runImpact(
      { prefillTokens: 1, readTokens: 1, outputTokens: 1, contextOutputProduct: 1, requests: 1, dollars: 1 },
      300,
    ),
    repo: 'https://github.com/zyra-project/sphere-sim',
  });
  assert.ok(html.includes('href="https://github.com/zyra-project/sphere-sim"'));
  // Shown without the scheme, and above the <h1> so it reads as a header element.
  assert.ok(html.indexOf('github.com/zyra-project/sphere-sim<') < html.indexOf('<h1>'));
});

test('no repo means no anchor at all, not an empty one', () => {
  const html = renderReport({
    ledger: ledger(),
    cost: priceLedger(ledger(), 'claude-opus-5'),
    impact: runImpact(
      { prefillTokens: 1, readTokens: 1, outputTokens: 1, contextOutputProduct: 1, requests: 1, dollars: 1 },
      300,
    ),
  });
  assert.ok(!html.includes('class="repo"'));
});
