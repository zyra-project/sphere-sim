/**
 * usage — what this project consumed, in dollars and in kilowatt-hours.
 *
 * Two halves with very different standing, and the report says so on its face:
 *
 *   COST     Measured token counts at published rates. Trustworthy.
 *   IMPACT   The same tokens through a model built out of guesses. An order of
 *            magnitude wide, and marked PROVISIONAL wherever it appears.
 *
 * Usage:
 *   node packages/usage/src/cli.ts [--root <dir>] [--model <id>] [--draws N]
 *                                  [--seed N] [--json <path>] [--html <path>]
 *
 * With no --root, reads the transcript directory Claude Code keeps for this
 * working directory. That default is a convenience, not a contract: pass --root
 * explicitly to analyse an archived tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readLedger } from './transcripts.ts';
import { priceLedger } from './cost.ts';
import { runImpact } from './impact.ts';
import type { Work } from './impact.ts';
import { renderReport } from './report.ts';

export function defaultTranscriptRoot(cwd: string, home: string): string {
  // Claude Code slugifies the project path by replacing every separator with a
  // dash, leading separator included: /home/user/x -> -home-user-x
  const slug = cwd.split(path.sep).join('-');
  return path.join(home, '.claude', 'projects', slug);
}

/**
 * The repository this report is about, as a browsable https URL.
 *
 * Detected rather than configured, like everything else the working tree already
 * knows. Handles the ssh remote form (git@host:owner/repo) as well as https.
 *
 * Returns null for anything that does not reduce to a plain http(s) URL. That
 * guard is load-bearing rather than defensive: a git remote is arbitrary text
 * and this value ends up in an href, so `javascript:` or a bare path must not
 * become a link.
 */
export function repoUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  const ssh = /^(?:ssh:\/\/)?git@([\w.-]+)[:/](.+?)(?:\.git)?$/.exec(raw);
  const url = ssh ? `https://${ssh[1]}/${ssh[2]}` : raw.replace(/\.git$/, '');
  return /^https?:\/\/[\w.-]+\/[\w./-]+$/.test(url) ? url : null;
}

function gitRemote(): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function integer(argv: readonly string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  // Validate the text, not Number(raw): Number('') is 0 and Number('12abc') is NaN,
  // and only one of those two mistakes announces itself.
  if (!/^\d+$/.test(raw)) throw new Error(`${name} expects a non-negative integer, got "${raw}"`);
  return Number(raw);
}

const usd = (n: number): string => '$' + n.toFixed(2);
const int = (n: number): string => Math.round(n).toLocaleString('en-US');
const pct = (n: number): string => (100 * n).toFixed(1) + '%';

export function main(argv: readonly string[]): number {
  const root = flag(argv, '--root') ?? defaultTranscriptRoot(process.cwd(), os.homedir());
  const modelId = flag(argv, '--model') ?? 'claude-opus-5';
  const draws = integer(argv, '--draws', 200_000);
  const seed = integer(argv, '--seed', 20260823);

  if (!fs.existsSync(root)) {
    console.error(`No transcript directory at ${root}`);
    console.error('Pass --root <dir> to point at an archived transcript tree.');
    return 1;
  }

  const ledger = readLedger(root);
  if (ledger.uniqueMessages === 0) {
    console.error(`No assistant messages with usage blocks under ${root}`);
    return 1;
  }
  const cost = priceLedger(ledger, modelId);

  const work: Work = {
    prefillTokens: ledger.total.uncached + ledger.total.write1h + ledger.total.write5m,
    readTokens: ledger.total.read,
    outputTokens: ledger.total.output,
    contextOutputProduct: ledger.contextOutputProduct,
    requests: ledger.uniqueMessages,
    dollars: cost.total,
  };
  const impact = runImpact(work, draws, seed);

  console.log('');
  console.log('  LEDGER');
  console.log(
    `    ${int(ledger.uniqueMessages)} assistant messages, deduplicated from ` +
      `${int(ledger.rawLines)} lines across ${int(ledger.files)} transcripts`,
  );
  console.log(
    `    ${ledger.firstAt?.slice(0, 10)} to ${ledger.lastAt?.slice(0, 10)}, ` +
      `${ledger.activeDays} active days`,
  );
  console.log(
    `    ${int(ledger.agents.workflow)} workflow agents, ` +
      `${int(ledger.agents.subagent)} plain subagents`,
  );
  console.log('');
  console.log('  COST — measured tokens, published rates');
  for (const line of cost.lines) {
    console.log(
      `    ${line.label.padEnd(36)} ${int(line.tokens).padStart(15)} ` +
        `${('$' + line.rate.toFixed(2)).padStart(7)}/M ${usd(line.amount).padStart(11)}`,
    );
  }
  console.log(`    ${'TOTAL'.padEnd(36)} ${int(cost.totalTokens).padStart(15)} ` +
    `${''.padStart(9)} ${usd(cost.total).padStart(11)}`);
  console.log('');
  for (const [bucket, amount] of Object.entries(cost.byBucket)) {
    console.log(`    ${bucket.padEnd(12)} ${usd(amount).padStart(11)}`);
  }
  console.log(`    cache reads are ${pct(cost.cacheReadShare)} of the bill`);
  console.log(
    `    without caching ${usd(cost.withoutCaching)} ` +
      `(${(cost.withoutCaching / cost.total).toFixed(1)}x) · ` +
      `all-1h TTL ${usd(cost.allOneHourTtl)}`,
  );
  console.log('');
  console.log('  IMPACT — PROVISIONAL. Modelled, not measured. See docs/USAGE-ACCOUNTING.md.');
  for (const m of impact.methods) {
    console.log(
      `    ${m.key}  ${m.name.padEnd(20)} ${int(m.kwh.p50).padStart(6)} kWh ` +
        `[${int(m.kwh.p5)} – ${int(m.kwh.p95)}]   ${m.role}`,
    );
  }
  const p = impact.pooled;
  console.log('');
  console.log(`    Electricity   ${int(p.kwh.p50).padStart(6)} kWh  [${int(p.kwh.p10)} – ${int(p.kwh.p90)}]`);
  console.log(`    Water         ${int(p.litres.p50).padStart(6)} L    [${int(p.litres.p10)} – ${int(p.litres.p90)}]`);
  console.log(
    `    Carbon        ${p.kgCo2eLocation.p50.toFixed(1).padStart(6)} kg   ` +
      `[${p.kgCo2eLocation.p10.toFixed(1)} – ${p.kgCo2eLocation.p90.toFixed(1)}]  location-based`,
  );
  console.log(
    `                  ${p.kgCo2eMarket.p50.toFixed(1).padStart(6)} kg   ` +
      `[${p.kgCo2eMarket.p10.toFixed(1)} – ${p.kgCo2eMarket.p90.toFixed(1)}]  market-based`,
  );
  console.log('');
  const t = impact.termShares;
  console.log(
    `    energy by term: prefill ${pct(t.prefill)} · attention ${pct(t.attention)} · ` +
      `decode ${pct(t.decode)} · staging ${pct(t.staging)}`,
  );
  console.log(
    `    method B on a typical short query: ${impact.shortQueryWhMedian.toFixed(2)} Wh ` +
      `vs 0.24–0.34 published (falsifier F2)`,
  );
  const bottomUp = impact.methods.find((m) => m.key === 'B');
  if (bottomUp !== undefined) {
    console.log(
      `    without caching: ${int(impact.noCacheKwhMedian)} kWh ` +
        `(${(impact.noCacheKwhMedian / bottomUp.kwh.p50).toFixed(1)}x method B)`,
    );
  }
  console.log('');

  const repo = repoUrl(flag(argv, '--repo') ?? gitRemote());

  const jsonPath = flag(argv, '--json');
  if (jsonPath !== undefined) {
    fs.writeFileSync(jsonPath, JSON.stringify({ repo, ledger, cost, impact }, null, 2));
    console.log(`  wrote ${jsonPath}`);
  }
  const htmlPath = flag(argv, '--html');
  if (htmlPath !== undefined) {
    fs.writeFileSync(htmlPath, renderReport({ ledger, cost, impact, repo }));
    console.log(`  wrote ${htmlPath}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
