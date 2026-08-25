/**
 * ledger.mjs — session transcripts to a deduplicated token ledger.
 *
 * Dependency-free, Node 18+. Everything downstream reads from here.
 *
 * THE COUNTING RULE, and why it is not "sum the file":
 *
 * A streaming assistant message is written once per content block, so one
 * message occupies several lines. What those lines carry differs by transcript
 * kind, and both obvious readings are wrong:
 *
 *   Summing lines      the main transcript repeats the FINAL usage on every
 *                      line, so the bill is multiplied by blocks-per-message.
 *                      Observed: 53,284 lines for 15,688 messages, 2.12x over.
 *   First line only    agent transcripts record PARTIAL usage mid-stream
 *                      (1, 1, 179 for one message), so this undercounts.
 *
 * The rule that survives both is the ELEMENTWISE MAXIMUM of every usage block
 * sharing a message id. A third case makes it load-bearing: a workflow agent is
 * filed twice, under subagents/ and subagents/workflows/, and either copy can be
 * truncated. The max reconciles them without knowing which is complete — which
 * is also why agents are counted by transcript BASENAME, not path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Claude Code slugifies a project path by replacing every separator with a dash. */
export function projectSlug(cwd) {
  return cwd.split(path.sep).join('-');
}

export function defaultRoot(cwd = process.cwd(), home = os.homedir()) {
  return path.join(home, '.claude', 'projects', projectSlug(cwd));
}

/** Every project directory Claude Code knows about, newest activity first. */
export function listProjects(home = os.homedir()) {
  const base = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(base, e.name);
      let mtime = 0;
      for (const f of findTranscripts(dir)) {
        try {
          mtime = Math.max(mtime, fs.statSync(f).mtimeMs);
        } catch {}
      }
      return { slug: e.name, dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function findTranscripts(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTranscripts(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** 'subagents/workflows/' contains 'subagents/', so workflow must be tested first. */
export function bucketOf(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.includes('subagents/workflows/')) return 'workflow';
  if (rel.includes('subagents/')) return 'subagent';
  return 'main';
}

const RANK = { main: 0, subagent: 1, workflow: 2 };

export function zeroTokens() {
  return { uncached: 0, write1h: 0, write5m: 0, read: 0, output: 0 };
}

export function addTokens(into, from) {
  for (const k of Object.keys(into)) into[k] += from[k];
}

export function contextTokens(t) {
  return t.uncached + t.write1h + t.write5m + t.read;
}

export function totalTokens(t) {
  return contextTokens(t) + t.output;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function usageOf(usage) {
  const creation = usage.cache_creation;
  return {
    uncached: num(usage.input_tokens),
    write1h: num(creation?.ephemeral_1h_input_tokens),
    write5m: num(creation?.ephemeral_5m_input_tokens),
    read: num(usage.cache_read_input_tokens),
    output: num(usage.output_tokens),
  };
}

function maxInto(into, from) {
  for (const k of Object.keys(into)) if (from[k] > into[k]) into[k] = from[k];
}

/**
 * A message's billing class: which rate card applies.
 *
 * `model` alone is not enough. Fast mode is the same model at premium pricing,
 * and a batch request is the same model at half. Both are recorded per message,
 * so the class is read rather than assumed — a run that mixed a Haiku subagent
 * into an Opus session prices correctly without anyone passing a flag.
 */
function classOf(message) {
  const u = message.usage ?? {};
  return {
    model: message.model ?? 'unknown',
    speed: u.speed === 'fast' ? 'fast' : 'standard',
    tier: u.service_tier === 'batch' ? 'batch' : 'standard',
  };
}

export function classKey(c) {
  return `${c.model}|${c.speed}|${c.tier}`;
}

/**
 * Read a transcript tree into a ledger.
 *
 * `filter` may narrow by session, branch, or time. Filtering happens at the
 * message level rather than the file level because one transcript can span
 * branches, and a PR-scoped report needs exactly the messages inside its window.
 *
 * Malformed lines are skipped rather than thrown on: a transcript being appended
 * to while this runs has a torn final line, and refusing to report anything
 * because of it would make the tool useless on a live session.
 */
export function readLedger(root, filter = {}) {
  const files = findTranscripts(root);
  const records = new Map();
  const agentFiles = new Map();
  const days = new Set();
  const sessions = new Map();
  const branches = new Map();
  const cwds = new Map();
  // The API records where inference ran. When it reports anything other than
  // 'not_available' this is the answer, and no geographic assumption is needed.
  const inferenceGeos = new Map();
  let rawLines = 0;
  let firstAt = null;
  let lastAt = null;
  let skippedSynthetic = 0;
  let skippedByFilter = 0;

  for (const file of files) {
    const bucket = bucketOf(root, file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const message = row.message;
      if (!message || message.role !== 'assistant' || !message.usage || !message.id) continue;

      // Synthetic messages carry a usage block but are not billed. Pricing them
      // at the session's model inflates the bill by whatever they contain.
      if (message.model === '<synthetic>') {
        skippedSynthetic++;
        continue;
      }

      if (!matches(row, filter)) {
        skippedByFilter++;
        continue;
      }

      rawLines++;
      // The slug cannot be reversed — a dash in the slug may be a path separator
      // or a literal dash in a directory name, and '-home-user-sphere-sim' is
      // both. The transcript records the real cwd, so read it rather than guess.
      if (row.cwd) cwds.set(row.cwd, (cwds.get(row.cwd) ?? 0) + 1);
      const geo = message.usage.inference_geo;
      if (typeof geo === 'string') inferenceGeos.set(geo, (inferenceGeos.get(geo) ?? 0) + 1);
      const stamp = row.timestamp;
      if (typeof stamp === 'string') {
        days.add(stamp.slice(0, 10));
        if (firstAt === null || stamp < firstAt) firstAt = stamp;
        if (lastAt === null || stamp > lastAt) lastAt = stamp;
      }
      if (bucket !== 'main') {
        const key = path.basename(file);
        const seen = agentFiles.get(key);
        if (seen === undefined || RANK[bucket] > RANK[seen]) agentFiles.set(key, bucket);
      }

      const tokens = usageOf(message.usage);
      const cls = classOf(message);
      const prior = records.get(message.id);
      if (prior === undefined) {
        // sessionId/gitBranch are recorded per message, not per line — counting
        // them on every line reports the raw line count and makes a one-session
        // project look like it had 53,400 of them.
        records.set(message.id, { bucket, cls, tokens, session: row.sessionId, branch: row.gitBranch });
      } else {
        if (RANK[bucket] > RANK[prior.bucket]) prior.bucket = bucket;
        maxInto(prior.tokens, tokens);
      }
    }
  }

  const byBucket = { main: zeroTokens(), subagent: zeroTokens(), workflow: zeroTokens() };
  const messages = { main: 0, subagent: 0, workflow: 0 };
  const byClass = new Map();
  const total = zeroTokens();
  let contextOutputProduct = 0;

  for (const rec of records.values()) {
    addTokens(byBucket[rec.bucket], rec.tokens);
    addTokens(total, rec.tokens);
    messages[rec.bucket]++;
    contextOutputProduct += contextTokens(rec.tokens) * rec.tokens.output;
    if (rec.session) sessions.set(rec.session, (sessions.get(rec.session) ?? 0) + 1);
    if (rec.branch) branches.set(rec.branch, (branches.get(rec.branch) ?? 0) + 1);
    const key = classKey(rec.cls);
    let entry = byClass.get(key);
    if (entry === undefined) {
      entry = { ...rec.cls, messages: 0, tokens: zeroTokens() };
      byClass.set(key, entry);
    }
    entry.messages++;
    addTokens(entry.tokens, rec.tokens);
  }

  let subagentCount = 0;
  let workflowCount = 0;
  for (const bucket of agentFiles.values()) {
    if (bucket === 'workflow') workflowCount++;
    else subagentCount++;
  }

  return {
    root,
    total,
    byBucket,
    byClass: [...byClass.values()].sort((a, b) => b.messages - a.messages),
    messages,
    agents: { subagent: subagentCount, workflow: workflowCount },
    rawLines,
    uniqueMessages: records.size,
    files: files.length,
    activeDays: days.size,
    firstAt,
    lastAt,
    sessions: [...sessions.entries()].map(([id, n]) => ({ id, messages: n })).sort((a, b) => b.messages - a.messages),
    branches: [...branches.entries()].map(([name, n]) => ({ name, messages: n })).sort((a, b) => b.messages - a.messages),
    cwd: [...cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    inferenceGeos: [...inferenceGeos.entries()]
      .map(([geo, n]) => ({ geo, lines: n }))
      .sort((a, b) => b.lines - a.lines),
    skippedSynthetic,
    skippedByFilter,
    contextOutputProduct,
  };
}

function matches(row, filter) {
  if (filter.session && row.sessionId !== filter.session) return false;
  if (filter.branch && row.gitBranch !== filter.branch) return false;
  if (filter.since && (!row.timestamp || row.timestamp < filter.since)) return false;
  if (filter.until && (!row.timestamp || row.timestamp > filter.until)) return false;
  return true;
}
