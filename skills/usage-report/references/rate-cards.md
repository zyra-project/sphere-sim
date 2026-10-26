# Rate cards

Rates live in `RATE_CARD` in `scripts/price.mjs`. Everything here is `PUB` —
published by the vendor and checkable against the pricing page. That is why the
cost half of this skill is measurement and the environmental half is not.

## Multipliers on the base input rate

| Class | Multiple | Note |
| --- | --- | --- |
| Uncached input | 1.00× | |
| Cache write, 5-minute TTL | 1.25× | **More** than the token it replaces |
| Cache write, 1-hour TTL | 2.00× | Twice base input |
| Cache read | 0.10× | The entire saving lives here; 0.05× on `claude-opus-5-5` |

The saving is never on the write. A workload that writes long-TTL caches it does
not read again is strictly worse off than one that never cached at all. This is
the single most misunderstood thing about cache billing, and it is why the report
always prints the without-caching and all-1h-TTL counterfactuals rather than a
bare cache line item.

**Batch requests bill at 50%**, applied on top of everything else.

**Fast mode is the same model at premium pricing** — on Opus-tier, $10/$50 per
MTok rather than $5/$25 ($8/$40 rather than $4/$20 on Claude Opus 5.5). It is recorded per message as `usage.speed`, so a
session that used it prices correctly without anyone passing a flag.

## Current rates, dollars per million tokens

| Model | Input | Output | Notes |
| --- | --- | --- | --- |
| `claude-opus-5-5` | 4 | 20 | fast: 8 / 40; cache reads 0.05× ($0.20) |
| `claude-opus-5` | 5 | 25 | fast: 10 / 50 |
| `claude-opus-4-8` | 5 | 25 | fast: 10 / 50 |
| `claude-opus-4-7` | 5 | 25 | |
| `claude-opus-4-6` | 5 | 25 | |
| `claude-fable-5` | 10 | 50 | |
| `claude-mythos-5` | 10 | 50 | |
| `claude-sonnet-5` | 3 | 15 | intro 2 / 10 through 2026-08-31 |
| `claude-sonnet-4-6` | 3 | 15 | |
| `claude-haiku-4-5` | 1 | 5 | |

Partner platforms (Bedrock, Vertex) are separately priced and are **not** covered
by this card.

## Introductory pricing expires

A rate entry may carry an `intro` block with an `until` date. Pricing traffic
from inside that window at the post-intro rate overstates it — for Sonnet 5 in
August 2026, by 50%. Rates are selected using the first timestamp in the scoped
ledger, so a report about last month prices at last month's rates.

## Adding a model

```js
'claude-something-new': {
  input: 5, output: 25,
  fast: { input: 10, output: 50 },              // omit if fast mode is unsupported
  read: 0.05,                                   // omit unless cache reads differ from 0.10x
  intro: { input: 3, output: 15, until: '2026-12-31' },  // omit if none
},
```

An unrecognised model is reported as **UNPRICED** and excluded from the total
rather than silently priced at a neighbour's rate. That makes the bill a visible
floor instead of a confident wrong number. Never substitute a similar model's
rates to make the warning go away — look the rates up.

## A per-model cache-read rate

Most models bill cache reads at 0.10× base input. Claude Opus 5.5 bills them at
0.05× ($0.20/MTok against $4 input). A rate entry with `read` overrides the
multiplier for that model only. Without it, an Opus 5.5 run's cache reads, usually
the largest token class, would be priced at double their rate.

## Mixed-model runs

Each billing class — model × speed × tier — is priced on its own card. The line
items in the report use a blended rate weighted by token volume, so with a single
class the blend is that class's rate exactly, and with several the per-class
breakdown is printed underneath.
