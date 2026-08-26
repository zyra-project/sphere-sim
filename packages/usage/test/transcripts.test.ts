// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The ledger.
 *
 * Every case here is a mistake that was actually made while building this, not a
 * hypothetical. Two of them cost more than a factor of two in the reported bill,
 * in opposite directions, which is why the dedupe rule is elementwise MAX rather
 * than either "sum the lines" or "take the first line".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bucketOf, contextTokens, readLedger, zeroTokens, addTokens } from '../src/transcripts.ts';

function line(id: string, usage: Record<string, unknown>, timestamp = '2026-08-10T00:00:00Z'): string {
  return JSON.stringify({ timestamp, message: { role: 'assistant', id, usage } });
}

function fixture(files: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  for (const [rel, lines] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n') + '\n');
  }
  return root;
}

test('F1: a message repeated once per content block is counted once', () => {
  // The main transcript repeats the FINAL usage on every line of a streamed
  // message. Summing lines multiplied the whole bill by 3.4x.
  const root = fixture({
    'main.jsonl': [
      line('msg_a', { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1000 }),
      line('msg_a', { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1000 }),
      line('msg_a', { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1000 }),
    ],
  });
  const ledger = readLedger(root);
  assert.equal(ledger.uniqueMessages, 1);
  assert.equal(ledger.rawLines, 3, 'the raw line count is still reported, as the inflation factor');
  assert.equal(ledger.total.output, 500);
  assert.equal(ledger.total.read, 1000);
});

test('F2: an agent recording PARTIAL usage mid-stream is counted at its maximum', () => {
  // Agent transcripts stream 1, then 1, then the real number. Taking the first
  // line understated agent output by ~3.8 M tokens across the project.
  const root = fixture({
    'subagents/a1.jsonl': [
      line('msg_b', { input_tokens: 5, output_tokens: 1 }),
      line('msg_b', { input_tokens: 5, output_tokens: 1 }),
      line('msg_b', { input_tokens: 5, output_tokens: 179 }),
    ],
  });
  assert.equal(readLedger(root).total.output, 179);
});

test('a workflow agent filed under both paths is one agent, not two', () => {
  // Regression: keying agents by full path reported every workflow agent a
  // second time as a plain subagent — 411 workflow and 415 subagents, when
  // there were 411 workflow agents and 4 others.
  const root = fixture({
    'subagents/w1.jsonl': [line('msg_c', { output_tokens: 20 })],
    'subagents/workflows/w1.jsonl': [line('msg_c', { output_tokens: 20 })],
    'subagents/plain.jsonl': [line('msg_d', { output_tokens: 7 })],
  });
  const ledger = readLedger(root);
  assert.deepEqual(ledger.agents, { workflow: 1, subagent: 1 });
  assert.equal(ledger.uniqueMessages, 2, 'the duplicate filing is one message, not two');
});

test('a message filed under both paths is attributed to the workflow bucket', () => {
  const root = fixture({
    'subagents/w1.jsonl': [line('msg_e', { output_tokens: 20 })],
    'subagents/workflows/w1.jsonl': [line('msg_e', { output_tokens: 20 })],
  });
  const ledger = readLedger(root);
  assert.equal(ledger.messages.workflow, 1);
  assert.equal(ledger.messages.subagent, 0);
});

test('a truncated copy never lowers the total', () => {
  // One of the two filings can be cut off mid-stream. The max reconciles them
  // without the caller needing to know which copy is complete.
  const root = fixture({
    'subagents/w2.jsonl': [line('msg_f', { output_tokens: 400 })],
    'subagents/workflows/w2.jsonl': [line('msg_f', { output_tokens: 3 })],
  });
  assert.equal(readLedger(root).total.output, 400);
});

test('bucketOf tests workflows before subagents', () => {
  // 'subagents/workflows/' contains 'subagents/'. Testing in the other order
  // reported zero workflow agents while the bucket held 411 of them.
  const root = '/r';
  assert.equal(bucketOf(root, '/r/subagents/workflows/x.jsonl'), 'workflow');
  assert.equal(bucketOf(root, '/r/subagents/x.jsonl'), 'subagent');
  assert.equal(bucketOf(root, '/r/x.jsonl'), 'main');
});

test('both cache-write TTLs are read, and they are separate line items', () => {
  const root = fixture({
    'main.jsonl': [
      line('msg_g', {
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 250 },
      }),
    ],
  });
  const ledger = readLedger(root);
  assert.equal(ledger.total.write1h, 100);
  assert.equal(ledger.total.write5m, 250);
});

test('contextOutputProduct is a per-message product, not a product of totals', () => {
  // The attention term needs SUM(context x output). Multiplying the totals
  // together instead gives 30*30=900 here rather than the correct 500.
  const root = fixture({
    'main.jsonl': [
      line('m1', { cache_read_input_tokens: 10, output_tokens: 20 }),
      line('m2', { cache_read_input_tokens: 20, output_tokens: 10 }),
    ],
  });
  const ledger = readLedger(root);
  assert.equal(ledger.contextOutputProduct, 10 * 20 + 20 * 10);
  assert.notEqual(ledger.contextOutputProduct, contextTokens(ledger.total) * ledger.total.output);
});

test('a torn final line is skipped, not thrown on', () => {
  // Transcripts are appended to while this runs. Refusing to report anything
  // because the last line is half-written would make the tool unusable live.
  const root = fixture({
    'main.jsonl': [line('m1', { output_tokens: 5 }), '{"message":{"role":"assist'],
  });
  assert.equal(readLedger(root).total.output, 5);
});

test('non-assistant rows and rows without usage are ignored', () => {
  const root = fixture({
    'main.jsonl': [
      JSON.stringify({ message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ message: { role: 'assistant', id: 'x' } }),
      line('m1', { output_tokens: 5 }),
    ],
  });
  const ledger = readLedger(root);
  assert.equal(ledger.uniqueMessages, 1);
  assert.equal(ledger.total.output, 5);
});

test('an empty tree reports zeros rather than throwing', () => {
  const ledger = readLedger(fixture({}));
  assert.equal(ledger.uniqueMessages, 0);
  assert.equal(ledger.firstAt, null);
  assert.equal(ledger.contextOutputProduct, 0);
});

test('a missing root is empty, not an exception', () => {
  assert.equal(readLedger('/definitely/not/here').files, 0);
});

test('active days count calendar days, not messages', () => {
  const root = fixture({
    'main.jsonl': [
      line('m1', { output_tokens: 1 }, '2026-08-10T01:00:00Z'),
      line('m2', { output_tokens: 1 }, '2026-08-10T23:00:00Z'),
      line('m3', { output_tokens: 1 }, '2026-08-12T05:00:00Z'),
    ],
  });
  const ledger = readLedger(root);
  assert.equal(ledger.activeDays, 2);
  assert.equal(ledger.firstAt, '2026-08-10T01:00:00Z');
  assert.equal(ledger.lastAt, '2026-08-12T05:00:00Z');
});

test('addTokens accumulates every field', () => {
  const a = zeroTokens();
  addTokens(a, { uncached: 1, write1h: 2, write5m: 3, read: 4, output: 5 });
  addTokens(a, { uncached: 1, write1h: 2, write5m: 3, read: 4, output: 5 });
  assert.deepEqual(a, { uncached: 2, write1h: 4, write5m: 6, read: 8, output: 10 });
});
