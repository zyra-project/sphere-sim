// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * report — the single page a reader who will never run the CLI actually sees.
 *
 * The layout is not decoration. It carries one argument that the numbers alone
 * do not: the cost half is measured and the impact half is modelled, and a
 * reader who takes the second as seriously as the first has been misled. So the
 * two halves are visually separated, the impact half is stamped PROVISIONAL, and
 * the three methods are drawn on a log axis where their disagreement is the
 * first thing the eye lands on. Averaging them into one bar would have hidden
 * exactly the finding worth reporting.
 *
 * The chart is a log-scale interval plot: one hue, thin marks, every median
 * direct-labelled. A static page has no hover layer, so the labels are not
 * optional — nothing else recovers the values.
 */

import type { Ledger } from './transcripts.ts';
import type { CostReport } from './cost.ts';
import type { ImpactReport } from './impact.ts';
import type { Band } from './montecarlo.ts';

export interface ReportInput {
  readonly ledger: Ledger;
  readonly cost: CostReport;
  readonly impact: ImpactReport;
  /** Browsable repository URL, or null. Validated by the caller before it gets here. */
  readonly repo?: string | null;
}

const INK = '#14181d';
const FAINT = '#949fab';
const RULE = '#e2e7ec';
/** Same hue, lightness-ordered. Both clear 3:1 on white; the range bar is the lighter step. */
const BAR = '#5f96d8';
const DOT = '#2a78d6';

const int = (n: number): string => Math.round(n).toLocaleString('en-US');
const usd = (n: number): string => '$' + n.toFixed(2);
const pct = (n: number): string => (100 * n).toFixed(0) + '%';

/**
 * A YYYY-MM-DD from a transcript timestamp, escaped, with a stable fallback.
 *
 * These come out of transcript JSON, and `--root` can point at a tree this
 * machine did not write, so they are untrusted input reaching HTML. Slicing to
 * ten characters does not make them safe: two of them land in the same text run,
 * giving twenty attacker-controlled characters in one tag context. The `?.slice`
 * spelling also rendered the literal string "undefined" on an empty ledger.
 */
function day(stamp: string | null): string {
  return typeof stamp === 'string' && stamp.length > 0 ? escapeHtml(stamp.slice(0, 10)) : '—';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Nearest 1-2-5 step at or beyond `v`. */
function niceBound(v: number, dir: 'up' | 'down'): number {
  const decade = Math.pow(10, Math.floor(Math.log10(v)));
  const steps = [1, 2, 5, 10].map((m) => m * decade);
  return dir === 'up'
    ? (steps.find((s) => s >= v) ?? steps[steps.length - 1])
    : ([...steps].reverse().find((s) => s <= v) ?? steps[0]);
}

/** Log-scale interval plot of the three methods plus the pooled band. */
function methodChart(impact: ImpactReport): string {
  const rows = impact.methods.map((m) => ({
    label: `${m.key}  ${m.name}`,
    note: m.role,
    lo: m.kwh.p5,
    mid: m.kwh.p50,
    hi: m.kwh.p95,
  }));
  const pooled = impact.pooled.kwh;

  const all = [...rows.flatMap((r) => [r.lo, r.hi]), pooled.p10, pooled.p90].filter(
    (v) => Number.isFinite(v) && v > 0,
  );
  if (all.length === 0) return '';
  // Snap the axis to the nearest 1-2-5 step rather than the nearest decade.
  // Decade bounds put a 1,032 kWh maximum on a 10,000-wide axis and threw away
  // half the plot width.
  const lo = niceBound(Math.min(...all), 'down');
  const hi = niceBound(Math.max(...all), 'up');
  const X0 = 214;
  const W = 700;
  const x = (v: number): number =>
    X0 + ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * W;

  const ticks: number[] = [];
  for (let d = lo; d <= hi; d *= 10) {
    for (const mult of [1, 2, 5]) {
      const t = d * mult;
      if (t >= lo && t <= hi) ticks.push(t);
    }
  }

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 980 292" width="980" height="292" role="img" aria-label="Three estimation methods for total electricity in kilowatt-hours on a log scale. ` +
      rows.map((r) => `${escapeHtml(r.label)} ${int(r.mid)}`).join(', ') +
      `, pooled best guess ${int(pooled.p50)}.">`,
  );
  for (const t of ticks) {
    parts.push(
      `<line x1="${x(t).toFixed(1)}" y1="26" x2="${x(t).toFixed(1)}" y2="214" stroke="${RULE}" stroke-width="1"/>`,
      `<text x="${x(t).toFixed(1)}" y="234" text-anchor="middle" font-size="11.5" fill="${FAINT}" font-family="ui-monospace,Menlo,Consolas,monospace">${int(t)}</text>`,
    );
  }
  parts.push(
    `<text x="${X0 + W / 2}" y="258" text-anchor="middle" font-size="11" fill="${FAINT}" letter-spacing="1.4">KILOWATT-HOURS &#183; LOG SCALE</text>`,
  );

  const ys = [52, 97, 142];
  rows.forEach((r, i) => {
    const y = ys[i];
    parts.push(
      `<text x="0" y="${y + 4}" font-size="13.5" fill="${INK}">${escapeHtml(r.label)}</text>`,
      `<text x="0" y="${y + 19}" font-size="11" fill="${FAINT}">${escapeHtml(r.note)}</text>`,
      `<line x1="${x(r.lo).toFixed(1)}" y1="${y}" x2="${x(r.hi).toFixed(1)}" y2="${y}" stroke="${BAR}" stroke-width="2" stroke-linecap="round"/>`,
      // 2px surface ring so the median separates from the bar it sits on
      `<circle cx="${x(r.mid).toFixed(1)}" cy="${y}" r="6" fill="${DOT}" stroke="#ffffff" stroke-width="2"/>`,
      `<text x="${(x(r.hi) + 12).toFixed(1)}" y="${y + 4}" font-size="13" font-weight="600" fill="${INK}" font-family="ui-monospace,Menlo,Consolas,monospace">${int(r.mid)}</text>`,
    );
  });

  const yp = 198;
  parts.push(
    `<line x1="0" y1="172" x2="980" y2="172" stroke="${RULE}" stroke-width="1"/>`,
    `<text x="0" y="${yp + 4}" font-size="13.5" font-weight="700" fill="${INK}">Best guess</text>`,
    `<text x="0" y="${yp + 19}" font-size="11" fill="${FAINT}">the three pooled, equally weighted</text>`,
    `<line x1="${x(pooled.p10).toFixed(1)}" y1="${yp}" x2="${x(pooled.p90).toFixed(1)}" y2="${yp}" stroke="${DOT}" stroke-width="4" stroke-linecap="round"/>`,
    `<circle cx="${x(pooled.p50).toFixed(1)}" cy="${yp}" r="7.5" fill="${DOT}" stroke="#ffffff" stroke-width="2"/>`,
    `<text x="${(x(pooled.p90) + 12).toFixed(1)}" y="${yp + 4}" font-size="13" font-weight="700" fill="${INK}" font-family="ui-monospace,Menlo,Consolas,monospace">${int(pooled.p50)}</text>`,
    '</svg>',
  );
  return parts.join('');
}

function bandText(b: Band, unit: string, digits = 0): string {
  const f = (n: number): string => (digits > 0 ? n.toFixed(digits) : int(n));
  return `${f(b.p50)} ${unit} <span class="band">[${f(b.p10)} &ndash; ${f(b.p90)}]</span>`;
}

export function renderReport(input: ReportInput): string {
  const { ledger, cost, impact } = input;
  const repo = input.repo ?? null;
  const p = impact.pooled;

  const costRows = cost.lines
    .map(
      (line) =>
        `<tr><td class="item">${escapeHtml(line.label)}</td>` +
        `<td class="n">${int(line.tokens)}</td>` +
        `<td class="n">$${line.rate.toFixed(2)}</td>` +
        `<td class="n amount">${usd(line.amount)}</td></tr>`,
    )
    .join('');

  const bucketRows = Object.entries(cost.byBucket)
    .map(
      ([bucket, amount]) =>
        `<tr><td class="item">${escapeHtml(bucket)}</td><td class="n amount">${usd(amount)}</td></tr>`,
    )
    .join('');

  const t = impact.termShares;
  const termRows = [
    ['Prefill — tokens computed through the network', t.prefill],
    ['Attention over the cached prefix', t.attention],
    ['Streaming weights to generate output', t.decode],
    ['Restaging persisted caches into memory', t.staging],
  ]
    .map(([label, share]) => `<tr><td class="item">${label}</td><td class="n mono">${pct(share as number)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>sphere-sim usage and impact</title><style>
 :root{--ink:${INK};--dim:#5d6873;--faint:${FAINT};--rule:${RULE};--rule-strong:#c3ccd6;
   --accent:#1a63d8;--warn-bg:#fff6e6;--warn-ink:#7a5200;--warn-rule:#e8c98a}
 *{box-sizing:border-box}
 body{margin:0;padding:56px 60px 48px;background:#fff;color:var(--ink);max-width:1080px;
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
 .topline{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 6px}
 .eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0}
 .repo{font-size:11.5px;color:var(--faint);text-decoration:none;border-bottom:1px solid var(--rule);
  font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap}
 .repo:hover{color:var(--accent);border-bottom-color:var(--accent)}
 h1{font-size:30px;line-height:1.15;margin:0 0 4px;font-weight:640;letter-spacing:-.015em}
 .sub{color:var(--dim);font-size:14px;margin:0 0 22px}
 .badge{display:block;margin:0 0 26px;background:var(--warn-bg);color:var(--warn-ink);
  border:1px solid var(--warn-rule);border-radius:5px;padding:9px 13px;font-size:12.5px;font-weight:600}
 .badge span{font-weight:400}
 h2{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:32px 0 9px}
 table{width:100%;border-collapse:collapse}
 th{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);
  text-align:left;padding:0 0 8px;border-bottom:1px solid var(--rule-strong)}
 th.n,td.n{text-align:right}
 td{padding:10px 0;border-bottom:1px solid var(--rule);font-size:13.5px;vertical-align:baseline}
 td.n,.mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
 td.item{padding-right:20px}
 .amount{font-weight:600}
 tr.total td{border-bottom:none;border-top:2px solid var(--ink);padding-top:12px;font-weight:700}
 .split{display:grid;grid-template-columns:1fr 1fr;gap:44px}
 .heroes{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--rule-strong);
  border-bottom:1px solid var(--rule-strong);margin:4px 0}
 .hero{padding:18px 22px 18px 0}
 .hero+.hero{padding-left:30px;border-left:1px solid var(--rule)}
 .hero .lbl{font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:7px}
 .hero .big{font-size:34px;line-height:1;font-weight:660;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
 .hero .big em{font-style:normal;font-size:18px;font-weight:500;color:var(--dim);margin-left:5px}
 .hero .band{display:block;margin-top:8px;font-size:12px;color:var(--dim);font-family:ui-monospace,Menlo,Consolas,monospace}
 .band{color:var(--faint);font-weight:400}
 svg{max-width:100%;height:auto}
 .scroll{overflow-x:auto}
 ol.notes{margin:10px 0 0;padding-left:20px;color:var(--dim);font-size:12.8px;line-height:1.62}
 ol.notes li{margin-bottom:5px} ol.notes b{color:var(--ink);font-weight:600}
 footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--rule);color:var(--faint);font-size:11.5px}
</style></head><body>

<div class="topline">
 <p class="eyebrow">Usage accounting</p>
 ${repo ? `<a class="repo" href="${escapeHtml(repo)}">${escapeHtml(repo.replace(/^https?:\/\//, ''))}</a>` : ''}
</div>
<h1>sphere-sim</h1>
<p class="sub">${int(ledger.uniqueMessages)} assistant messages &#183;
 ${day(ledger.firstAt)} to ${day(ledger.lastAt)} &#183;
 ${ledger.activeDays} active days &#183; ${escapeHtml(cost.modelId)}</p>

<h2>Cost &mdash; measured</h2>
<div class="scroll"><table>
 <thead><tr><th>Line item</th><th class="n">Tokens</th><th class="n">Rate / 1M</th><th class="n">Amount</th></tr></thead>
 <tbody>${costRows}
 <tr class="total"><td class="item">Total</td><td class="n">${int(cost.totalTokens)}</td><td class="n"></td><td class="n">${usd(cost.total)}</td></tr>
 </tbody></table></div>

<div class="split">
 <div><h2>Attribution</h2><table><tbody>${bucketRows}</tbody></table></div>
 <div><h2>Counterfactuals</h2><table><tbody>
  <tr><td class="item">Cache reads, share of bill</td><td class="n mono">${pct(cost.cacheReadShare)}</td></tr>
  <tr><td class="item">Without prompt caching</td><td class="n mono">${usd(cost.withoutCaching)}</td></tr>
  <tr><td class="item">Every write at the 1-hour TTL</td><td class="n mono">${usd(cost.allOneHourTtl)}</td></tr>
 </tbody></table></div>
</div>

<h2>Impact &mdash; provisional</h2>
<div class="badge">PROVISIONAL. Modelled, not measured.
 <span>Only the token counts above are measured. Model size, serving hardware, batch size, fleet
 utilisation and datacentre siting are non-public and drive this answer more than the tokens do.
 The band is the result; the midpoint is just its middle.</span></div>

<div class="heroes">
 <div class="hero"><div class="lbl">Electricity</div>
  <div class="big">${int(p.kwh.p50)}<em>kWh</em></div>
  <span class="band">${int(p.kwh.p10)} &ndash; ${int(p.kwh.p90)}</span></div>
 <div class="hero"><div class="lbl">Water</div>
  <div class="big">${int(p.litres.p50)}<em>litres</em></div>
  <span class="band">${int(p.litres.p10)} &ndash; ${int(p.litres.p90)}</span></div>
 <div class="hero"><div class="lbl">Carbon &#183; location-based</div>
  <div class="big">${p.kgCo2eLocation.p50.toFixed(0)}<em>kg CO2e</em></div>
  <span class="band">${p.kgCo2eLocation.p10.toFixed(0)} &ndash; ${p.kgCo2eLocation.p90.toFixed(0)} &#183;
   market-based ${p.kgCo2eMarket.p50.toFixed(0)}</span></div>
</div>

<h2>Three ways of getting there</h2>
<div class="scroll">${methodChart(impact)}</div>

<div class="split">
 <div><h2>Where the energy goes</h2><table><tbody>${termRows}</tbody></table></div>
 <div><h2>Checks</h2><table><tbody>
  <tr><td class="item">Method B on a typical short query</td><td class="n mono">${impact.shortQueryWhMedian.toFixed(2)} Wh</td></tr>
  <tr><td class="item">Published, same query</td><td class="n mono">0.24 &ndash; 0.34 Wh</td></tr>
  <tr><td class="item">Energy without prompt caching</td><td class="n mono">${int(impact.noCacheKwhMedian)} kWh</td></tr>
  <tr><td class="item">Monte Carlo draws &#183; seed</td><td class="n mono">${int(impact.draws)} &#183; ${impact.seed}</td></tr>
 </tbody></table></div>
</div>

<h2>Notes</h2>
<ol class="notes">
 <li><b>The two halves do not have the same standing.</b> Cost is measured token counts at published
  rates. Impact is those same counts through a chain of non-public constants. Quoting the second as
  confidently as the first is the main way this report can mislead.</li>
 <li><b>The methods disagree more than any one of them is uncertain.</b> Their medians span
  ${int(impact.methods[0].kwh.p50)} to ${int(impact.methods[2].kwh.p50)} kWh. That gap measures what
  is unknowable from outside the operator, and it is why they are pooled rather than averaged.</li>
 <li><b>Method B does not reproduce the published per-query figures</b> &mdash;
  ${impact.shortQueryWhMedian.toFixed(2)} Wh against 0.24&ndash;0.34. Some of that is real (this is a
  larger model, and those are vendor self-reports) and some is bias in the model. Method A exists to
  keep the discrepancy visible rather than buried.</li>
 <li><b>Carbon is reported on two bases because they answer different questions.</b> Location-based
  uses the grid the facility physically draws from; market-based credits power purchase agreements.
  Neither is wrong, and reporting only the lower one would be.</li>
 <li>Excludes training amortisation, embodied hardware carbon, local compute, and the network.</li>
</ol>

<footer>Regenerate with <code>npm run usage</code>. Deduplicated from ${int(ledger.rawLines)} lines
 across ${int(ledger.files)} transcripts. Methodology: docs/USAGE-ACCOUNTING.md.</footer>
</body></html>`;
}
