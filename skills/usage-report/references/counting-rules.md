# Counting rules

Why deduplicating transcripts is the whole problem, and what each way of getting
it wrong costs. Read this if someone challenges the token numbers.

## The shape of a transcript

Claude Code writes one JSONL line per content block of an assistant message. A
message that streamed text, then a tool call, then more text occupies several
lines — and every one of those lines carries a `message.usage` block.

So a naive count has to decide what those repeated blocks mean, and both obvious
answers are wrong.

## Failure 1 — summing every line

The main transcript **repeats the FINAL usage on every line** of a streamed
message. Summing therefore multiplies the bill by the mean number of content
blocks per message.

Observed on a real project: 53,284 lines for 15,688 actual messages. The
reported total was **$5,250.42 against a true $2,472.86 — overstated 2.12×**.
Message counts and cache-read volume were inflated by the same factor, which is
what made the error hard to spot: every number was consistently wrong, so nothing
looked out of place.

## Failure 2 — taking the first line

The obvious fix for the first failure. It fails in the other direction, because
**agent transcripts record PARTIAL usage mid-stream** — one message logged
`output_tokens` of 1, then 1, then 179. Agent output came out ~3.8 M tokens short.

## The rule that survives both

**Elementwise maximum of every usage block sharing a message id.**

- Under failure 1, every block already holds the final value, so the max is that
  value.
- Under failure 2, the final block is the largest, so the max is again that value.

A third case makes it load-bearing rather than merely correct: **a workflow agent
is filed twice**, under `subagents/` and again under `subagents/workflows/`, and
either copy can be truncated mid-stream. The max reconciles the pair without
needing to know which one is complete.

## Consequences of the double filing

**Agents are counted by transcript basename, not path.** Counting by path
reported 411 workflow agents *plus* 415 subagents; there were 411 workflow agents
and 4 others — the same agents counted twice.

**Bucket order matters.** `subagents/workflows/` contains the substring
`subagents/`, so the workflow test has to come first. Testing in the other order
reported zero workflow agents while the bucket held 411.

## Things that are not billable

**Synthetic messages** (`message.model === "<synthetic>"`) carry a usage block but
are not billed. Pricing them at the session's model inflates the total.

## Fields worth knowing about

Each transcript line carries more than the usage block, and reading it beats
asking the user:

| Field | Use |
| --- | --- |
| `message.model` | Per-message rate card. A session that delegated to a Haiku subagent prices correctly with no flag |
| `message.usage.speed` | `fast` is the same model at premium pricing |
| `message.usage.service_tier` | `batch` bills at half |
| `sessionId` | Scope to one session |
| `gitBranch` | Scope to one branch, which is how PR scoping works |
| `cwd` | The real project path. The directory slug cannot be reversed — a dash in it may be a separator or a literal dash |
| `timestamp` | Date windows, active-day counts |

## The one measured input to the energy model

Attention re-reads the whole context once per generated token, so its cost is a
**product**: `SUM over messages of (context × output)`. No per-message average
recovers it, because context length and output length correlate — measured at
1.22× above what independence predicts on one real project, since long contexts
drew long replies.

Everything else in the energy model is a guess. This one is not, which is why it
is computed per message rather than from totals.
