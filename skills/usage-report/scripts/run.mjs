#!/usr/bin/env node
/**
 * run.mjs — the entry point.
 *
 * Two modes:
 *
 *   --list      print what is discoverable: projects, sessions, branches, date
 *               range, models. Run this FIRST. It is what tells you whether the
 *               scope is already unambiguous (usually it is) or whether the user
 *               genuinely needs to be asked.
 *
 *   (default)   produce the report for the resolved scope.
 *
 * The design principle: detect everything detectable, ask only what changes the
 * answer. Transcript location, models, speed tier, session ids, branches, dates
 * and token counts are all in the files. Grid siting is not, and it moves carbon
 * by an order of magnitude — so that is the one question usually worth asking.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import { readLedger, defaultRoot, listProjects } from './ledger.mjs';
import { priceLedger } from './price.mjs';
import { runImpact, GRID_PRESETS, REGIONS, GEO_FAMILIES, COOLING_REGIMES } from './impact.mjs';
import { renderReport } from './report.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f, fallback = undefined) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flags = (f) => argv.reduce((out, a, i) => (a === f && argv[i + 1] ? [...out, argv[i + 1]] : out), []);
const intFlag = (f, fallback) => {
  const raw = flag(f);
  if (raw === undefined) return fallback;
  // Validate the text, not Number(raw): Number('') is 0 and Number('12abc') is
  // NaN, and only one of those two mistakes announces itself.
  if (!/^\d+$/.test(raw)) throw new Error(`${f} expects a non-negative integer, got "${raw}"`);
  return Number(raw);
};

const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const usd = (n) => '$' + n.toFixed(2);
const pctS = (n) => (100 * n).toFixed(1) + '%';

function resolveRoot() {
  const explicit = flag('--root');
  if (explicit) return explicit;
  const project = flag('--project');
  if (project) {
    const match = listProjects().find((p) => p.slug === project || p.slug.endsWith(project));
    if (!match) throw new Error(`no transcript directory matching "${project}". Run --list.`);
    return match.dir;
  }
  return defaultRoot();
}

/**
 * Map a pull request to a scope.
 *
 * Best-effort by design. `gh` may be absent, unauthenticated, or the repo
 * private — in every one of those cases the right move is to say so and let the
 * caller fall back to --branch, not to fail the whole report.
 */
function resolvePr(number) {
  try {
    const raw = execFileSync(
      'gh',
      ['pr', 'view', String(number), '--json', 'headRefName,createdAt,mergedAt,closedAt,title'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pr = JSON.parse(raw);
    return {
      branch: pr.headRefName,
      // No end timestamp means the PR is still open; leave `until` unset so the
      // window runs to now rather than silently truncating at creation.
      until: pr.mergedAt ?? pr.closedAt ?? undefined,
      title: pr.title,
    };
  } catch {
    return null;
  }
}

/**
 * The repository this report is about, as a browsable https URL.
 *
 * Detected rather than configured, like everything else the transcripts or the
 * working tree already know. Handles the ssh remote form (git@host:owner/repo)
 * as well as https, and returns null for anything it cannot turn into a plain
 * http(s) URL — a git remote is arbitrary text, and this ends up in an href.
 */
export function repoUrl(explicit) {
  let raw = explicit;
  if (raw === undefined) {
    try {
      raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  const ssh = /^(?:ssh:\/\/)?git@([\w.-]+)[:/](.+?)(?:\.git)?$/.exec(raw);
  const url = ssh ? `https://${ssh[1]}/${ssh[2]}` : raw.replace(/\.git$/, '');
  // Only an http(s) URL becomes a link. Anything else — file://, javascript:,
  // a bare path — is dropped rather than rendered into an anchor.
  return /^https?:\/\/[\w.-]+\/[\w./-]+$/.test(url) ? url : null;
}

/** What the work produced, if this is a git repo. Optional context, never load-bearing. */
function deliveredWork(since, until) {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  const out = {};
  try {
    const range = ['--count', 'HEAD'];
    if (since) range.push(`--since=${since}`);
    if (until) range.push(`--until=${until}`);
    out.commits = Number(git(['rev-list', ...range]));
  } catch {}
  try {
    const files = git(['ls-files']).split('\n').filter(Boolean);
    out.trackedFiles = files.length;
    out.testFiles = files.filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f) || /(^|\/)tests?\//.test(f)).length;
  } catch {}
  return Object.keys(out).length > 0 ? out : null;
}

function doList() {
  const projects = listProjects();
  console.log('\n  PROJECTS (newest activity first)');
  if (projects.length === 0) console.log('    none found under ~/.claude/projects');
  for (const p of projects.slice(0, 12)) {
    console.log(`    ${p.slug}`);
  }
  const root = resolveRoot();
  console.log(`\n  SCOPE OF ${root}`);
  if (!fs.existsSync(root)) {
    console.log('    (does not exist)');
    return 0;
  }
  const l = readLedger(root);
  console.log(`    ${int(l.uniqueMessages)} messages · ${l.firstAt?.slice(0, 10)} to ${l.lastAt?.slice(0, 10)} · ${l.activeDays} active days`);
  console.log(`    sessions : ${l.sessions.length}`);
  for (const s of l.sessions.slice(0, 8)) console.log(`      ${s.id}  (${int(s.messages)} messages)`);
  console.log(`    branches : ${l.branches.length}`);
  for (const b of l.branches.slice(0, 8)) console.log(`      ${b.name}  (${int(b.messages)} messages)`);
  console.log(`    models   : ${l.byClass.map((c) => `${c.model}/${c.speed}/${c.tier} × ${int(c.messages)}`).join(', ')}`);
  const reported = l.inferenceGeos.filter((g) => g.geo !== 'not_available');
  console.log(`    inference_geo : ${reported.length > 0
    ? reported.map((g) => g.geo).join(', ') + '  <- reported by the API; do NOT assume a geography'
    : 'not reported — the API did not say where inference ran'}`);
  console.log(`    agents   : ${int(l.agents.workflow)} workflow, ${int(l.agents.subagent)} plain subagent`);
  console.log('\n  AMBIGUOUS?');
  const ambiguities = [];
  if (projects.length > 1) ambiguities.push(`${projects.length} projects exist — confirm which one, or pass --project`);
  if (l.sessions.length > 1) ambiguities.push(`${l.sessions.length} sessions in scope — ask if they want one, or pass --session`);
  if (l.branches.length > 1) ambiguities.push(`${l.branches.length} branches in scope — ask if they want one, or pass --branch`);
  if (ambiguities.length === 0) console.log('    no — scope is unambiguous, do not ask about it');
  for (const a of ambiguities) console.log(`    ${a}`);
  console.log('    grid siting: use inference_geo above if the API reported one; otherwise ask,');
  console.log('      accept the wide default, or state a --geo family as an explicit assumption');
  console.log(`    presets: ${Object.keys(GRID_PRESETS).join(', ')}`);
  console.log(`    regions: ${Object.keys(REGIONS).join(', ')}`);
  console.log(`    geographies: ${Object.keys(GEO_FAMILIES).join(', ')} (explicit assumptions, labelled as such)`);
  console.log(`    cooling    : ${Object.keys(COOLING_REGIMES).join(', ')} — water and energy trade off, see the reference`);
  console.log('    a sandbox\'s own region is NOT a proxy for where inference ran\n');
  return 0;
}

function main() {
  if (has('--list')) return doList();

  const root = resolveRoot();
  if (!fs.existsSync(root)) {
    console.error(`No transcript directory at ${root}. Run with --list to see what exists.`);
    return 1;
  }

  const filter = {};
  let title = flag('--title');
  let scopeLabel = [];

  const prNumber = flag('--pr');
  if (prNumber) {
    const pr = resolvePr(prNumber);
    if (pr === null) {
      console.error(`Could not read PR #${prNumber} (gh missing, unauthenticated, or no such PR).`);
      console.error('Fall back to --branch <name> and/or --since/--until.');
      return 1;
    }
    filter.branch = pr.branch;
    if (pr.until) filter.until = pr.until;
    title = title ?? `PR #${prNumber} — ${pr.title}`;
    scopeLabel.push(`PR #${prNumber} (branch ${pr.branch})`);
  }

  for (const [f, key] of [['--session', 'session'], ['--branch', 'branch'], ['--since', 'since'], ['--until', 'until']]) {
    const v = flag(f);
    if (v !== undefined) {
      filter[key] = v;
      scopeLabel.push(`${key} ${v}`);
    }
  }

  const ledger = readLedger(root, filter);
  if (ledger.uniqueMessages === 0) {
    console.error(`No assistant messages matched under ${root}.`);
    if (Object.keys(filter).length > 0) console.error(`Filter was: ${JSON.stringify(filter)}. Run --list to see valid values.`);
    return 1;
  }

  const cost = priceLedger(ledger);

  const presets = flags('--grid');
  const wantImpact = !has('--no-impact');
  const impact = wantImpact
    ? runImpact(
        {
          prefillTokens: cost.billable.uncached + cost.billable.write1h + cost.billable.write5m,
          readTokens: cost.billable.read,
          outputTokens: cost.billable.output,
          contextOutputProduct: ledger.contextOutputProduct,
          dollars: cost.total,
        },
        { draws: intFlag('--draws', 200_000), seed: intFlag('--seed', 20260823), presets, region: flag('--region') ?? null, geo: flag('--geo') ?? null, cooling: flag('--cooling') ?? null },
      )
    : null;

  const meta = {
    title: title ?? (ledger.cwd ? path.basename(ledger.cwd) : path.basename(root)),
    scope: scopeLabel.length > 0 ? scopeLabel.join(' · ') : 'all sessions',
    repo: repoUrl(flag('--repo')),
  };

  console.log('');
  console.log(`  ${meta.title}  —  ${meta.scope}${meta.repo ? '  —  ' + meta.repo : ''}`);
  console.log(`    ${int(ledger.uniqueMessages)} messages, deduplicated from ${int(ledger.rawLines)} lines across ${int(ledger.files)} transcripts`);
  console.log(`    ${ledger.firstAt?.slice(0, 10)} to ${ledger.lastAt?.slice(0, 10)} · ${ledger.activeDays} active days`);
  if (ledger.skippedSynthetic > 0) console.log(`    ${int(ledger.skippedSynthetic)} synthetic message(s) excluded — not billable`);
  console.log('');
  console.log('  COST — measured tokens, published rates');
  for (const l of cost.lines) {
    console.log(`    ${l.label.padEnd(36)} ${int(l.tokens).padStart(15)} ${('$' + l.rate.toFixed(2)).padStart(7)}/M ${usd(l.amount).padStart(11)}`);
  }
  console.log(`    ${'TOTAL'.padEnd(36)} ${int(cost.totalTokens).padStart(15)} ${''.padStart(9)} ${usd(cost.total).padStart(11)}`);
  if (cost.priced.length > 1) {
    console.log('');
    for (const c of cost.priced) {
      console.log(`    ${(c.model + (c.speed === 'fast' ? ' fast' : '') + (c.tier === 'batch' ? ' batch' : '')).padEnd(30)} ${int(c.messages).padStart(7)} msgs ${usd(c.amount).padStart(11)}`);
    }
  }
  if (cost.unpriced.length > 0) {
    console.log('');
    console.log('    UNPRICED — excluded from the total, add to RATE_CARD in scripts/price.mjs:');
    for (const u of cost.unpriced) console.log(`      ${u.model} (${int(u.messages)} messages)`);
  }
  console.log('');
  for (const [b, v] of Object.entries(cost.byBucket)) if (v > 0) console.log(`    ${b.padEnd(12)} ${usd(v).padStart(11)}`);
  console.log(`    cache reads are ${pctS(cost.cacheReadShare)} of the bill`);
  console.log(`    without caching ${usd(cost.withoutCaching)} (${(cost.withoutCaching / cost.total).toFixed(1)}x) · all-1h TTL ${usd(cost.allOneHourTtl)}`);

  if (impact !== null) {
    console.log('');
    console.log('  IMPACT — PROVISIONAL. Modelled, not measured.');
    if (impact.region) {
      const r = REGIONS[impact.region];
      console.log(`    region: ${impact.region} (${r.label}) — ${r.grid} gCO2/kWh, ${(100 * r.cfe).toFixed(0)}% carbon-free`);
      console.log('    NOTE: this must be where INFERENCE ran, not where a sandbox or shell ran.');
    }
    if (impact.cooling) {
      const c = COOLING_REGIMES[impact.cooling];
      console.log(`    cooling: ${c.label} — WUE ${c.wue[0]}–${c.wue[1]} L/kWh(IT), PUE ${c.pue[0]}–${c.pue[1]}`);
      console.log(`      ${c.note}`);
    }
    if (impact.geo) {
      const g = GEO_FAMILIES[impact.geo];
      console.log(`    geography ASSUMED: ${g.label} (${g.low}–${g.high} gCO2eq/kWh). ${g.note}`);
    }
    if (presets.length > 0) console.log(`    grid assumption: ${presets.join(' + ')}`);
    for (const m of impact.methods) {
      console.log(`    ${m.key}  ${m.name.padEnd(20)} ${int(m.kwh.p50).padStart(6)} kWh [${int(m.kwh.p5)} – ${int(m.kwh.p95)}]   ${m.role}`);
    }
    const p = impact.pooled;
    console.log('');
    console.log(`    Electricity   ${int(p.kwh.p50).padStart(6)} kWh  [${int(p.kwh.p10)} – ${int(p.kwh.p90)}]`);
    console.log(`    Water         ${int(p.litres.p50).padStart(6)} L    [${int(p.litres.p10)} – ${int(p.litres.p90)}]`);
    console.log(`    Carbon        ${p.kgCo2eLocation.p50.toFixed(1).padStart(6)} kg   [${p.kgCo2eLocation.p10.toFixed(1)} – ${p.kgCo2eLocation.p90.toFixed(1)}]  location-based`);
    console.log(`                  ${p.kgCo2eMarket.p50.toFixed(1).padStart(6)} kg   [${p.kgCo2eMarket.p10.toFixed(1)} – ${p.kgCo2eMarket.p90.toFixed(1)}]  market-based`);
    const t = impact.termShares;
    console.log('');
    console.log(`    energy by term: prefill ${pctS(t.prefill)} · attention ${pctS(t.attention)} · decode ${pctS(t.decode)} · staging ${pctS(t.staging)}`);
    console.log(`    method B on a typical short query: ${impact.shortQueryWhMedian.toFixed(2)} Wh vs 0.24–0.34 published (falsifier F2)`);
  }

  const work = deliveredWork(flag('--since'), flag('--until'));
  if (work) {
    console.log('');
    console.log(`  DELIVERED (git): ${Object.entries(work).map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`);
  }
  console.log('');

  const jsonPath = flag('--json');
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({ meta, ledger, cost, impact, work }, null, 2));
    console.log(`  wrote ${jsonPath}`);
  }
  const htmlPath = flag('--html');
  if (htmlPath) {
    fs.writeFileSync(htmlPath, renderReport({ ledger, cost, impact, meta }));
    console.log(`  wrote ${htmlPath}`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}
