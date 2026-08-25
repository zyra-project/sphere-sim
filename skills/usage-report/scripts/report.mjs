/**
 * report.mjs — the single page for someone who will never run the CLI.
 *
 * The layout carries an argument the numbers alone do not: the cost half is
 * measured and the impact half is modelled, and a reader who treats them alike
 * has been misled. So the halves are separated, the impact half is stamped
 * PROVISIONAL, and the three methods are drawn on a log axis where their
 * disagreement is the first thing the eye lands on. Averaging them into one bar
 * would hide the finding worth reporting.
 *
 * Static page, so there is no hover layer — every median is direct-labelled,
 * because nothing else recovers the value.
 */

const INK = '#14181d';
const FAINT = '#949fab';
const RULE = '#e2e7ec';
/** Same hue, lightness-ordered; both clear 3:1 on white. Lighter step is the range bar. */
const BAR = '#5f96d8';
const DOT = '#2a78d6';

const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const usd = (n) => '$' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
const pct = (n) => (100 * n).toFixed(0) + '%';
/**
 * A YYYY-MM-DD from a transcript timestamp, escaped, with a stable fallback.
 * `--root` can point at a transcript tree this machine did not write, so these
 * are untrusted input reaching HTML; slicing to ten characters is not enough,
 * since two of them land in the same text run.
 */
const day = (stamp) => (typeof stamp === 'string' && stamp.length > 0 ? esc(stamp.slice(0, 10)) : '—');
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Nearest 1-2-5 step at or beyond v, so a 1,032 max does not sit on a 10,000 axis. */
function niceBound(v, dir) {
  const decade = Math.pow(10, Math.floor(Math.log10(v)));
  const steps = [1, 2, 5, 10].map((m) => m * decade);
  return dir === 'up'
    ? steps.find((s) => s >= v) ?? steps[steps.length - 1]
    : [...steps].reverse().find((s) => s <= v) ?? steps[0];
}

function methodChart(impact) {
  const rows = impact.methods.map((m) => ({
    label: `${m.key}  ${m.name}`, note: m.role, lo: m.kwh.p5, mid: m.kwh.p50, hi: m.kwh.p95,
  }));
  const pooled = impact.pooled.kwh;
  const all = [...rows.flatMap((r) => [r.lo, r.hi]), pooled.p10, pooled.p90].filter((v) => Number.isFinite(v) && v > 0);
  if (all.length === 0) return '';
  const lo = niceBound(Math.min(...all), 'down');
  const hi = niceBound(Math.max(...all), 'up');
  const X0 = 214, W = 700;
  const x = (v) => X0 + ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * W;

  const ticks = [];
  for (let d = lo; d <= hi; d *= 10) for (const m of [1, 2, 5]) {
    const t = d * m;
    if (t >= lo && t <= hi) ticks.push(t);
  }

  const p = [
    `<svg viewBox="0 0 980 292" width="980" height="292" role="img" aria-label="Three estimation methods for total electricity in kilowatt-hours, log scale. ` +
      rows.map((r) => `${esc(r.label)} ${int(r.mid)}`).join(', ') + `, pooled ${int(pooled.p50)}.">`,
  ];
  for (const t of ticks) {
    p.push(`<line x1="${x(t).toFixed(1)}" y1="26" x2="${x(t).toFixed(1)}" y2="214" stroke="${RULE}" stroke-width="1"/>`);
    p.push(`<text x="${x(t).toFixed(1)}" y="234" text-anchor="middle" font-size="11.5" fill="${FAINT}" font-family="ui-monospace,Menlo,Consolas,monospace">${int(t)}</text>`);
  }
  p.push(`<text x="${X0 + W / 2}" y="258" text-anchor="middle" font-size="11" fill="${FAINT}" letter-spacing="1.4">KILOWATT-HOURS &#183; LOG SCALE</text>`);

  [52, 97, 142].forEach((y, i) => {
    const r = rows[i];
    if (!r) return;
    p.push(`<text x="0" y="${y + 4}" font-size="13.5" fill="${INK}">${esc(r.label)}</text>`);
    p.push(`<text x="0" y="${y + 19}" font-size="11" fill="${FAINT}">${esc(r.note)}</text>`);
    p.push(`<line x1="${x(r.lo).toFixed(1)}" y1="${y}" x2="${x(r.hi).toFixed(1)}" y2="${y}" stroke="${BAR}" stroke-width="2" stroke-linecap="round"/>`);
    p.push(`<circle cx="${x(r.mid).toFixed(1)}" cy="${y}" r="6" fill="${DOT}" stroke="#fff" stroke-width="2"/>`);
    p.push(`<text x="${(x(r.hi) + 12).toFixed(1)}" y="${y + 4}" font-size="13" font-weight="600" fill="${INK}" font-family="ui-monospace,Menlo,Consolas,monospace">${int(r.mid)}</text>`);
  });

  const yp = 198;
  p.push(`<line x1="0" y1="172" x2="980" y2="172" stroke="${RULE}" stroke-width="1"/>`);
  p.push(`<text x="0" y="${yp + 4}" font-size="13.5" font-weight="700" fill="${INK}">Best guess</text>`);
  p.push(`<text x="0" y="${yp + 19}" font-size="11" fill="${FAINT}">the three pooled, equally weighted</text>`);
  p.push(`<line x1="${x(pooled.p10).toFixed(1)}" y1="${yp}" x2="${x(pooled.p90).toFixed(1)}" y2="${yp}" stroke="${DOT}" stroke-width="4" stroke-linecap="round"/>`);
  p.push(`<circle cx="${x(pooled.p50).toFixed(1)}" cy="${yp}" r="7.5" fill="${DOT}" stroke="#fff" stroke-width="2"/>`);
  p.push(`<text x="${(x(pooled.p90) + 12).toFixed(1)}" y="${yp + 4}" font-size="13" font-weight="700" fill="${INK}" font-family="ui-monospace,Menlo,Consolas,monospace">${int(pooled.p50)}</text>`);
  p.push('</svg>');
  return p.join('');
}

const row = (label, value) => `<tr><td class="item">${label}</td><td class="n mono">${value}</td></tr>`;


/**
 * The assumptions that produced these numbers, on the face of the page.
 *
 * A report that travels without them is unreadable six months later: 25 kg and
 * 79 kg are the same project under different siting, and nothing else on the
 * page distinguishes them.
 */
function assumptions(impact) {
  const parts = [];
  if (impact.cooling) parts.push(`cooling <b>${esc(impact.cooling)}</b>`);
  if (impact.region) parts.push(`region <b>${esc(impact.region)}</b> (published)`);
  else if (impact.geo) parts.push(`geography <b>${esc(impact.geo)}</b> (assumed)`);
  if (impact.presets && impact.presets.length) parts.push(`grid <b>${impact.presets.map(esc).join(' + ')}</b>`);
  if (parts.length === 0) parts.push('no siting or cooling assumed — the widest band');
  return `<span style="display:block;margin-top:7px;font-weight:400">Assumptions: ${parts.join(' &#183; ')}.</span>`;
}

export function renderReport({ ledger, cost, impact, meta = {} }) {
  const title = meta.title ?? 'Claude Code usage';
  const scope = meta.scope ?? 'all sessions';

  const costRows = cost.lines.map((l) =>
    `<tr><td class="item">${esc(l.label)}</td><td class="n">${int(l.tokens)}</td><td class="n">$${l.rate.toFixed(2)}</td><td class="n amount">${usd(l.amount)}</td></tr>`).join('');

  const classRows = cost.priced.map((c) =>
    row(`${esc(c.model)}${c.speed === 'fast' ? ' <b>fast</b>' : ''}${c.tier === 'batch' ? ' <b>batch</b>' : ''}
      <span class="sub2">${int(c.messages)} messages</span>`, usd(c.amount))).join('');

  const unpricedRows = cost.unpriced.length === 0 ? '' :
    `<h2>Unpriced</h2><div class="badge warn">${cost.unpriced.length} message class(es) had no rate card and are
     <b>excluded from the total</b>. <span>Add them to RATE_CARD in scripts/price.mjs:
     ${cost.unpriced.map((u) => esc(u.model)).join(', ')}.</span></div>`;

  const bucketRows = Object.entries(cost.byBucket)
    .filter(([, v]) => v > 0)
    .map(([b, v]) => row(esc(b), usd(v))).join('');

  const impactSection = impact === null ? '' : `
<h2>Impact &mdash; provisional</h2>
<div class="badge">PROVISIONAL. Modelled, not measured.
 <span>Only the token counts above are measured. Model size, serving hardware, batch size, fleet
 utilisation and datacentre siting are non-public and drive this more than the tokens do. The band
 is the result; the midpoint is just its middle.</span>
 ${assumptions(impact)}</div>

<div class="heroes">
 <div class="hero"><div class="lbl">Electricity</div><div class="big">${int(impact.pooled.kwh.p50)}<em>kWh</em></div>
  <span class="band">${int(impact.pooled.kwh.p10)} &ndash; ${int(impact.pooled.kwh.p90)}</span></div>
 <div class="hero"><div class="lbl">Water</div><div class="big">${int(impact.pooled.litres.p50)}<em>litres</em></div>
  <span class="band">${int(impact.pooled.litres.p10)} &ndash; ${int(impact.pooled.litres.p90)}</span></div>
 <div class="hero"><div class="lbl">Carbon &#183; location-based</div>
  <div class="big">${impact.pooled.kgCo2eLocation.p50.toFixed(0)}<em>kg CO2e</em></div>
  <span class="band">${impact.pooled.kgCo2eLocation.p10.toFixed(0)} &ndash; ${impact.pooled.kgCo2eLocation.p90.toFixed(0)}
   &#183; market-based ${impact.pooled.kgCo2eMarket.p50.toFixed(0)}</span></div>
</div>

<h2>Three ways of getting there</h2>
<div class="scroll">${methodChart(impact)}</div>

<div class="split">
 <div><h2>Where the energy goes</h2><table><tbody>
  ${row('Prefill &mdash; tokens computed through the network', pct(impact.termShares.prefill))}
  ${row('Attention over the cached prefix', pct(impact.termShares.attention))}
  ${row('Streaming weights to generate output', pct(impact.termShares.decode))}
  ${row('Restaging persisted caches into memory', pct(impact.termShares.staging))}
 </tbody></table></div>
 <div><h2>Checks</h2><table><tbody>
  ${row('Method B on a typical short query', impact.shortQueryWhMedian.toFixed(2) + ' Wh')}
  ${row('Published, same query', '0.24 &ndash; 0.34 Wh')}
  ${row('Energy without prompt caching', int(impact.noCacheKwhMedian) + ' kWh')}
  ${row('Monte Carlo draws &#183; seed', int(impact.draws) + ' &#183; ' + impact.seed)}
 </tbody></table></div>
</div>

<h2>Notes</h2>
<ol class="notes">
 <li><b>The two halves do not have the same standing.</b> Cost is measured token counts at published
  rates. Impact is those counts through a chain of non-public constants. Quoting the second as
  confidently as the first is the main way this report can mislead.</li>
 <li><b>The methods disagree more than any one of them is uncertain.</b> Their medians span
  ${int(Math.min(...impact.methods.map((m) => m.kwh.p50)))} to
  ${int(Math.max(...impact.methods.map((m) => m.kwh.p50)))} kWh &mdash; a gap that measures what is
  unknowable from outside the operator, which is why they are pooled rather than averaged.</li>
 <li><b>Method B does not reproduce the published per-query figures</b> &mdash;
  ${impact.shortQueryWhMedian.toFixed(2)} Wh against 0.24&ndash;0.34. Some of that is real (a larger
  model, and those are vendor self-reports) and some is bias. Method A keeps it visible.</li>
 <li><b>Carbon is on two bases because they answer different questions.</b> Location-based uses the
  grid the facility draws from; market-based credits power purchase agreements. Reporting only the
  lower one would flatter the result.</li>
 <li>Excludes training amortisation, embodied hardware carbon, local compute, and the network.</li>
</ol>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
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
 .badge.warn{background:#fdecea;border-color:#f0b3ab;color:#8a2018}
 h2{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:32px 0 9px}
 table{width:100%;border-collapse:collapse}
 th{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);
  text-align:left;padding:0 0 8px;border-bottom:1px solid var(--rule-strong)}
 th.n,td.n{text-align:right}
 td{padding:10px 0;border-bottom:1px solid var(--rule);font-size:13.5px;vertical-align:baseline}
 td.n,.mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
 td.item{padding-right:20px}
 .sub2{display:block;color:var(--faint);font-size:11.5px;margin-top:2px}
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
 .hero .band,.band{color:var(--faint);font-weight:400}
 .hero .band{display:block;margin-top:8px;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
 svg{max-width:100%;height:auto}
 .scroll{overflow-x:auto}
 ol.notes{margin:10px 0 0;padding-left:20px;color:var(--dim);font-size:12.8px;line-height:1.62}
 ol.notes li{margin-bottom:5px} ol.notes b{color:var(--ink);font-weight:600}
 footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--rule);color:var(--faint);font-size:11.5px}
</style></head><body>

<div class="topline">
 <p class="eyebrow">Usage accounting</p>
 ${meta.repo ? `<a class="repo" href="${esc(meta.repo)}">${esc(meta.repo.replace(/^https?:\/\//, ''))}</a>` : ''}
</div>
<h1>${esc(title)}</h1>
<p class="sub">${esc(scope)} &#183; ${int(ledger.uniqueMessages)} assistant messages &#183;
 ${day(ledger.firstAt)} to ${day(ledger.lastAt)} &#183;
 ${ledger.activeDays} active days</p>

<h2>Cost &mdash; measured</h2>
<div class="scroll"><table>
 <thead><tr><th>Line item</th><th class="n">Tokens</th><th class="n">Rate / 1M</th><th class="n">Amount</th></tr></thead>
 <tbody>${costRows}
 <tr class="total"><td class="item">Total</td><td class="n">${int(cost.totalTokens)}</td><td class="n"></td><td class="n">${usd(cost.total)}</td></tr>
 </tbody></table></div>
${unpricedRows}

<div class="split">
 <div><h2>By model</h2><table><tbody>${classRows}</tbody></table></div>
 <div><h2>Counterfactuals</h2><table><tbody>
  ${row('Cache reads, share of bill', pct(cost.cacheReadShare))}
  ${row('Without prompt caching', usd(cost.withoutCaching))}
  ${row('Every write at the 1-hour TTL', usd(cost.allOneHourTtl))}
  ${bucketRows ? '' : ''}
 </tbody></table></div>
</div>

${bucketRows ? `<h2>Attribution</h2><table><tbody>${bucketRows}</tbody></table>` : ''}
${impactSection}

<footer>Deduplicated from ${int(ledger.rawLines)} lines across ${int(ledger.files)} transcripts${
    ledger.skippedSynthetic ? `, excluding ${int(ledger.skippedSynthetic)} synthetic message(s)` : ''
  }. Regenerate with the usage-report skill.</footer>
</body></html>`;
}
