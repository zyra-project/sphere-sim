---
name: usage-report
description: Reports what Claude Code work actually consumed — token counts, dollar cost at published rates, and a provisional estimate of electricity, water, and carbon. Use this whenever the user asks what a project, pull request, session, or stretch of work cost them, how many tokens something burned, what their spend or usage looks like, whether caching is paying off, or what the environmental or carbon footprint of their AI usage was. Also use it for "how much have I spent on this repo", "token report", "usage breakdown", "cost of this PR", "energy/water/CO2 of this work", and any request to compare cost across sessions, branches, or models — even when the user does not say the word "report".
---

# Usage report

Answers two questions about Claude Code work, and keeps them apart because they
are not equally answerable.

**What did it cost?** Measured. Token counts come out of the session
transcripts, rates are published, and the arithmetic has nowhere to hide.

**What did it burn?** Modelled. Only the token counts are known — model size,
serving hardware, batch size, fleet utilisation and datacentre siting are
non-public and each moves the answer more than the tokens do. The band spans
roughly an order of magnitude, and it is reported as PROVISIONAL.

Presenting the second as confidently as the first is the main way this skill can
mislead someone. Keep the distinction visible in whatever you write.

## Do this first

```bash
node scripts/run.mjs --list
```

This prints every project, session, branch, model and date range it can see, and
then tells you explicitly whether the scope is ambiguous. Run it before asking
the user anything — most of what you might be tempted to ask is already in the
transcripts, and asking for it makes the skill feel like a form.

## What to ask, and what never to ask

The principle: **detect everything detectable, ask only what changes the answer.**

Never ask for these — `--list` already has them: transcript location, which
models were used, fast-mode or batch tier, session ids, branch names, date
range, message counts, token counts, how many subagents ran.

Ask about these, and only when they apply:

**Scope, only when `--list` reports it ambiguous.** More than one project,
session, or branch in range means you genuinely cannot tell which one they mean.
One of each means don't ask — just report it. If they named a PR, use `--pr N`
and skip the question entirely.

**Where the work ran**, if they want the environmental half. This is the one
question that reliably matters: siting moves carbon by about twenty-fold between
a hydro grid and a coal-heavy one. Offer the presets and make "I don't know" a
first-class answer, because the wide default is honest and most people genuinely
don't know:

| Preset | When |
| --- | --- |
| `unknown` | Default. Wide band, no claim about siting |
| `us-average` | Work ran on US infrastructure |
| `low-carbon` | Nordic, French, or Québécois hydro/nuclear grid |
| `coal-heavy` | Coal-dominant grid |
| `closed-loop-cooling` | Facility known to use closed-loop cooling; combine with a grid preset |

Before asking anything about siting, check the `inference_geo` line in `--list`.
The API records where inference ran; when it reports a geography, use it and
assume nothing. When it reports `not_available`, that is genuine absence of
evidence, not licence to substitute a guess.

If they know the specific cloud region **where inference ran**, `--region us-east1`
uses Google's published 2024 figures. If they only know the market,
`--geo us|eu|nordic` states that as an explicit assumption and labels itself
ASSUMED in the output. `--list` prints both sets.

**A sandbox's own region is not a proxy for where inference ran.** An agent's
shell runs on a small CPU container; the model runs on accelerators elsewhere,
plausibly a different provider and region, and the container has no visibility
into it. Its egress IP is worse still, since a NAT gateway can sit in another
region. Pinning a region because that is where the shell egresses gives a number
that sounds rigorous and measures the wrong thing — worse than the honest wide
default, because it looks precise.

If someone argues that co-location must be cheaper — less cross-region traffic,
lower latency — the arithmetic does not support it. A project moving ~14 GB pays
$0.14–$1.27 in cross-region egress against a $2,498 bill, and one region of
latency adds minutes to tens of hours of generation. Both are three-plus orders
of magnitude too small to drive placement, while accelerator scarcity, which
pushes the other way, is the dominant cost. Explain this rather than accepting
the assumption; `references/impact-model.md` has the table.

**Whether the region is even worth asking about.** Energy dominates under every
assumption — grid intensity is ~16% of the carbon variance when the region is
unknown, and knowing it exactly only narrows the band from ~50x to ~37x. Asking
which *US* region is not worth a question; the energy uncertainty swallows it.
Asking whether it might be a hydro or nuclear grid is, because that is a 10x move
on the headline. Pitch the question at that level.

**How the facility is cooled**, if the water number matters to them. On-site
water is not a continuum — it is a three-way regime choice, and the regimes are
100× apart on site water but only ~1.7× apart on *total* water, because dry
cooling buys its water saving with 20–50% more electricity that brings its own
water at the power station. Whether that trade is worth it depends entirely on
the grid: going dry saves 6.75× on a wind/solar grid and 1.19× on a thermal one,
while always costing about a third more carbon. `--cooling
evaporative|air-cooled|liquid-closed`. Note that "closed-loop" and "air-cooled"
are not the same thing — direct-to-chip liquid gets near-zero water *and* the
best PUE, with no tradeoff at all.

**Whether they want the impact half at all.** Some people want the bill and
nothing else. `--no-impact` skips the modelling entirely and the report is purely
measurement. If they only asked about cost, don't volunteer the whole model —
mention it exists in one line and let them ask.

Ask at most two questions. If you find yourself drafting a third, you are
probably asking for something `--list` would have told you.

## Producing the report

```bash
# whole project
node scripts/run.mjs --html /tmp/usage.html

# one pull request (resolves branch and merge window via gh)
node scripts/run.mjs --pr 42 --html /tmp/pr-42.html

# one session, or one branch, or a date window
node scripts/run.mjs --session <id>
node scripts/run.mjs --branch feature/thing
node scripts/run.mjs --since 2026-08-01 --until 2026-08-15

# grid assumption, cost only, machine-readable
node scripts/run.mjs --grid us-average --grid closed-loop-cooling
node scripts/run.mjs --no-impact
node scripts/run.mjs --json /tmp/usage.json
```

The report links back to the repository it describes, detected from the `origin`
git remote (ssh and https remote forms both work). `--repo <url>` overrides it;
anything that is not a plain http(s) URL is dropped rather than turned into a
link, since a git remote is arbitrary text.

Other flags: `--project <slug>` or `--root <dir>` to analyse a project other than
the current directory, `--draws N` and `--seed N` for the Monte Carlo (defaults
200,000 and 20260823 — the seed is printed so a rerun distinguishes a
methodology change from sampling noise), `--title` to override the heading.

Render the HTML to an image if the user would rather look at it than open a file.

## Reporting the numbers back

Lead with the measured figure. Give the modelled one as a band, never as a point
value dressed up with decimals — "about 140 kWh, somewhere between 20 and 600"
is the honest shape, and "138.4 kWh" is not.

Three findings are usually worth surfacing because they are counter-intuitive
and they hold across most agentic projects:

- **Cache reads dominate the bill** — typically around two-thirds — because a
  long session re-reads its whole prefix every turn. That is not waste; the
  without-caching counterfactual in the report shows what the alternative costs.
- **A cache write costs more than the token it replaces**, 1.25× at the
  5-minute TTL and 2× at the 1-hour. The saving is entirely on the reads, so a
  workload that writes long-TTL caches it never reads is worse off than one that
  never cached.
- **The three estimation methods disagree by more than any one of them is
  uncertain.** That gap is the actual finding: it measures how much of the answer
  is unknowable from outside the operator. Report the spread, don't average it
  away.

If the report flags UNPRICED message classes, say so plainly — those tokens are
excluded from the total, so the bill is a floor until someone adds the missing
rates to `scripts/price.mjs`.

## When something doesn't work

**No transcripts found.** Claude Code keeps them under
`~/.claude/projects/<slugified-cwd>/`. If the work happened elsewhere, pass
`--root` or `--project`. Work done through the API rather than Claude Code leaves
no transcript and cannot be analysed this way.

**`--pr` fails.** It shells out to `gh`, which may be missing, unauthenticated,
or blocked on a private repo. Fall back to `--branch` plus `--since`/`--until`;
the report is identical, you just resolved the window yourself.

**A model has no rate card.** Add it to `RATE_CARD` in `scripts/price.mjs` from
the published pricing page. Do not substitute a similar model's rates — a number
that looks authoritative and is wrong is worse than a visible gap.

**The totals drift between runs.** Expected on a live session: the transcripts
grow while the report runs, and the report's own turns land in its totals.

## Going deeper

Read these only when the task calls for it — the summaries above are enough for
an ordinary report.

- `references/counting-rules.md` — why deduplication is the whole problem, the
  two ways of getting it wrong, and what each error costs. Read this if someone
  challenges the token numbers or you need to explain the method.
- `references/rate-cards.md` — the published rates, the cache and batch
  multipliers, and how to add or update a model.
- `references/impact-model.md` — the three methods, every constant with its
  provenance class, the falsifiers, and what the model excludes. Read this before
  defending or adjusting any environmental number.
