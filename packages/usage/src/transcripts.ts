// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * transcripts — turning a directory of session logs into a token ledger.
 *
 * ## The question
 *
 * How much did this project actually consume? The session transcripts record it,
 * one `usage` block per assistant message. Summing them looks trivial. It is not,
 * and the first two attempts at it were both wrong by more than a factor of two —
 * in opposite directions.
 *
 * ## The two failure modes, both observed
 *
 * A streaming assistant message is written to the transcript once per content
 * block, so one message occupies several lines. What those lines carry differs by
 * transcript kind, and that difference is the whole problem:
 *
 *   F1  **The main transcript repeats the FINAL usage on every line.** Summing
 *       lines therefore multiplies the bill by the mean number of content blocks
 *       per message. Measured here: 53,188 lines for 15,639 messages, and a
 *       reported total of $5,250.42 against a true $2,472.86 — overstated 2.12x.
 *
 *   F2  **Agent transcripts record PARTIAL usage mid-stream.** The early lines of
 *       one message carried output_tokens of 1, then 1, then 179. Taking the first
 *       line per message — the obvious fix for F1 — understated agent output by
 *       about 3.8 M tokens.
 *
 * The rule that survives both is the ELEMENTWISE MAXIMUM of every usage block
 * sharing a message id. It is not a heuristic: under F1 every block is the final
 * value so the max is that value, and under F2 the final block is the largest so
 * the max is again that value. A third case makes it load-bearing rather than
 * merely correct — a workflow agent is filed twice, under `subagents/` and again
 * under `subagents/workflows/`, and one of the two copies can be truncated
 * mid-stream. The max reconciles the pair without needing to know which is which.
 *
 * ## Why not just ask the API
 *
 * Because the transcripts are what exists after the fact. This module is
 * archaeology on a finished project, not instrumentation added before one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Which loop produced a message. A workflow agent is also a subagent; `workflow` wins. */
export type Bucket = 'main' | 'subagent' | 'workflow';

/** The five billable quantities, exactly as the API reports them. */
export interface Tokens {
  /** Input tokens that missed the cache entirely. */
  uncached: number;
  /** Cache writes with the 1-hour TTL. Billed at 2x base input. */
  write1h: number;
  /** Cache writes with the 5-minute TTL. Billed at 1.25x base input. */
  write5m: number;
  /** Cache reads. Billed at 0.1x base input. */
  read: number;
  /** Generated tokens. */
  output: number;
}

export interface Ledger {
  /** Totals across every bucket. */
  total: Tokens;
  /** Totals per bucket, so attribution does not require a second pass. */
  byBucket: Record<Bucket, Tokens>;
  /** Deduplicated assistant messages, per bucket. */
  messages: Record<Bucket, number>;
  /**
   * Distinct agents, by bucket.
   *
   * Keyed by transcript BASENAME, not path. A workflow agent is filed twice —
   * once under `subagents/` and again under `subagents/workflows/` — so keying
   * by path reports every workflow agent a second time as a plain subagent.
   * That is the same double-count that inflated the first attribution table.
   */
  agents: { subagent: number; workflow: number };
  /** Raw JSONL lines carrying a usage block, before deduplication. */
  rawLines: number;
  /** Deduplicated message count. `rawLines / messages` is the F1 inflation factor. */
  uniqueMessages: number;
  /** Transcript files scanned. */
  files: number;
  /** Calendar days (UTC) on which any message was recorded. */
  activeDays: number;
  /** ISO timestamps of the first and last message, or null for an empty tree. */
  firstAt: string | null;
  lastAt: string | null;
  /**
   * Sum over messages of (context length x output length).
   *
   * This is the only quantity here that exists for the energy model rather than
   * the bill. Attention re-reads the whole context once per generated token, so
   * the work is a product, not a sum, and no per-message average recovers it —
   * long contexts and long replies correlate (by 1.22x in this project), and an
   * independence assumption undercounts by exactly that factor.
   */
  contextOutputProduct: number;
}

export function zeroTokens(): Tokens {
  return { uncached: 0, write1h: 0, write5m: 0, read: 0, output: 0 };
}

export function addTokens(into: Tokens, from: Tokens): void {
  into.uncached += from.uncached;
  into.write1h += from.write1h;
  into.write5m += from.write5m;
  into.read += from.read;
  into.output += from.output;
}

/** Every input token that had to be in the context window for this message. */
export function contextTokens(t: Tokens): number {
  return t.uncached + t.write1h + t.write5m + t.read;
}

export function totalTokens(t: Tokens): number {
  return contextTokens(t) + t.output;
}

/** Recursively collect `.jsonl` files, skipping nothing — subagent trees are nested. */
export function findTranscripts(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTranscripts(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Which bucket a transcript file belongs to, from its path relative to the root.
 *
 * Order matters: `subagents/workflows/` also contains `subagents/`, so the
 * workflow test has to come first. An earlier version tested `subagents/` first
 * and reported zero workflow agents while the workflow bucket held 411 of them.
 */
export function bucketOf(root: string, file: string): Bucket {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.includes('subagents/workflows/')) return 'workflow';
  if (rel.includes('subagents/')) return 'subagent';
  return 'main';
}

const RANK: Record<Bucket, number> = { main: 0, subagent: 1, workflow: 2 };

function usageOf(usage: Record<string, unknown>): Tokens {
  const creation = usage['cache_creation'] as Record<string, unknown> | undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    uncached: num(usage['input_tokens']),
    write1h: num(creation?.['ephemeral_1h_input_tokens']),
    write5m: num(creation?.['ephemeral_5m_input_tokens']),
    read: num(usage['cache_read_input_tokens']),
    output: num(usage['output_tokens']),
  };
}

/** Elementwise maximum, in place. See the F1/F2 note at the top of this file. */
function maxInto(into: Tokens, from: Tokens): void {
  if (from.uncached > into.uncached) into.uncached = from.uncached;
  if (from.write1h > into.write1h) into.write1h = from.write1h;
  if (from.write5m > into.write5m) into.write5m = from.write5m;
  if (from.read > into.read) into.read = from.read;
  if (from.output > into.output) into.output = from.output;
}

interface Record_ {
  bucket: Bucket;
  tokens: Tokens;
}

/**
 * Read a transcript tree into a ledger.
 *
 * Malformed lines are skipped rather than thrown on: a transcript being written
 * while this runs will have a torn final line, and refusing to report anything
 * because of it would make the tool unusable on a live session.
 */
export function readLedger(root: string): Ledger {
  const files = findTranscripts(root);
  const records = new Map<string, Record_>();
  const agentFiles = new Map<string, Bucket>();
  const days = new Set<string>();
  let rawLines = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const file of files) {
    const bucket = bucketOf(root, file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = parsed['message'] as Record<string, unknown> | undefined;
      if (!message || message['role'] !== 'assistant') continue;
      const usage = message['usage'] as Record<string, unknown> | undefined;
      const id = message['id'];
      if (!usage || typeof id !== 'string') continue;

      rawLines++;
      const stamp = parsed['timestamp'];
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

      const tokens = usageOf(usage);
      const prior = records.get(id);
      if (prior === undefined) {
        records.set(id, { bucket, tokens });
      } else {
        if (RANK[bucket] > RANK[prior.bucket]) prior.bucket = bucket;
        maxInto(prior.tokens, tokens);
      }
    }
  }

  const byBucket: Record<Bucket, Tokens> = {
    main: zeroTokens(),
    subagent: zeroTokens(),
    workflow: zeroTokens(),
  };
  const messages: Record<Bucket, number> = { main: 0, subagent: 0, workflow: 0 };
  const total = zeroTokens();
  let contextOutputProduct = 0;

  for (const rec of records.values()) {
    addTokens(byBucket[rec.bucket], rec.tokens);
    addTokens(total, rec.tokens);
    messages[rec.bucket]++;
    contextOutputProduct += contextTokens(rec.tokens) * rec.tokens.output;
  }

  let subagentFiles = 0;
  let workflowFiles = 0;
  for (const bucket of agentFiles.values()) {
    if (bucket === 'workflow') workflowFiles++;
    else subagentFiles++;
  }

  return {
    total,
    byBucket,
    messages,
    agents: { subagent: subagentFiles, workflow: workflowFiles },
    rawLines,
    uniqueMessages: records.size,
    files: files.length,
    activeDays: days.size,
    firstAt,
    lastAt,
    contextOutputProduct,
  };
}
