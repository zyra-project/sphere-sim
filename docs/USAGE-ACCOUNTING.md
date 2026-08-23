# sphere-sim — Usage, Cost, and Environmental Accounting

What this project consumed, how the numbers were obtained, and — the part that
matters most — which of them can be relied on.

Run it:

```
npm run usage                                  # text report
npm run usage -- --html /tmp/usage.html        # the shareable page
npm run usage -- --root <dir> --json out.json  # an archived transcript tree
```

---

## How to read this

| Class | Meaning | Risk if wrong |
| --- | --- | --- |
| `MEAS` | Counted from the session transcripts | **None** — re-derivable from the same files |
| `PUB` | Published by the vendor; checkable against a pricing or disclosure page | Low — but check the citation |
| `IND` | An industry or government figure for a comparable facility | Moderate — right order, wrong specific site |
| `ASSUME` | Not published anywhere; chosen by us | **High** — this is where the estimate breaks |

**The central conclusion, stated up front:** every input to the *cost* figure is
`MEAS` or `PUB`. Every input to the *environmental* figure that matters is `IND`
or `ASSUME`. The bill is measurement and can be quoted. The energy, water, and
carbon numbers are a model whose band spans an order of magnitude, and they are
marked **PROVISIONAL** everywhere they appear.

This is the same split docs/PARAMETERS.md draws between geometric and photometric
parameters, and it carries the same instruction: build it, test it, report the
band, and do not tune anything against it. Optimising against unmeasured
constants produces confident nonsense.

---

## Part 1 — Cost (`MEAS` + `PUB`)

### The counting rule, and the two ways it goes wrong

A streaming assistant message is written to the transcript **once per content
block**, so one message occupies several lines. What those lines carry differs by
transcript kind, and both readings of "just sum the file" are wrong:

| Failure | What happens | Measured cost of the error |
| --- | --- | --- |
| Summing every line | The main transcript repeats the FINAL usage on each line, so the bill is multiplied by the mean blocks-per-message | 53,188 lines counted for 15,639 messages; **$5,250.42 reported against a true $2,472.86**, overstated 2.12x |
| Taking the first line | Agent transcripts record PARTIAL usage mid-stream (`1`, `1`, `179` for one message) | agent output understated by ~3.8 M tokens |

The rule that survives both is the **elementwise maximum of every usage block
sharing a message id**. Under the first failure every block already holds the
final value, so the max is that value; under the second the final block is the
largest, so the max is again that value.

A third case makes it load-bearing rather than merely correct: a workflow agent
is filed **twice**, under `subagents/` and again under `subagents/workflows/`,
and either copy can be truncated. The max reconciles the pair without needing to
know which is complete. The same double-filing is why agents are counted by
transcript *basename* — counting by path reported 411 workflow agents plus 415
subagents when the truth was 411 workflow agents and 4 others.

### The rate card (`PUB`)

Rates are dollars per million tokens. Cache multiples apply to the base input rate.

| Class | Multiple | Why it matters |
| --- | --- | --- |
| Uncached input | 1.00x | |
| Cache write, 5-minute TTL | 1.25x | A write costs **more** than the token it replaces |
| Cache write, 1-hour TTL | 2.00x | Twice base input |
| Cache read | 0.10x | The entire saving lives here |

The saving is never on the write. A workload that writes long-TTL caches it does
not read again is strictly worse off than one that never cached at all — which is
why the report prints the without-caching and all-1h-TTL counterfactuals rather
than a bare cache line item.

---

## Part 2 — Environmental impact (`IND` + `ASSUME`, PROVISIONAL)

### Why three methods

A single estimate here would be indistinguishable from a confident one. The three
below share no inputs of consequence, so their disagreement measures something no
within-method error bar can: how much of the answer is unknowable from outside
the operator.

| | Method | Route | Standing |
| --- | --- | --- | --- |
| **A** | Vendor-anchored | Published per-query energy, rescaled by this workload's shape | **Floor** — the disclosures cover smaller models |
| **B** | Bottom-up | FLOPs, memory traffic, watts from first principles | Most specific to this workload |
| **C** | Cost-anchored | Bill → gross margin → accelerator-hours → watts | **Ceiling** — assumes every dollar buys power-proportional compute |

They are **pooled, not averaged**: the reported band is the three concatenated
with equal weight, so the between-method spread survives into the result instead
of being smoothed away.

### The one term that is measured

Attention re-reads the whole context once per generated token, so its cost is a
product — `SUM over messages of (context x output)` — not a sum. No per-message
average recovers it. Measured here it is 2.10 x 10^12 token-pairs, **22% above**
what an independence assumption gives, because long contexts in this project drew
long replies. Everything else in method B is a guess; this is not.

### Water is two different things

Reported water is the sum of two unrelated quantities:

- **On-site** (`IND`, 0.05–1.5 L/kWh) — evaporated for cooling. Spans closed-loop
  designs near zero to conventional evaporative towers.
- **Off-site** (`IND`, 0.8–3.2 L/kWh) — *consumed* generating the electricity.
  Withdrawal is an order of magnitude larger but mostly returned; consumption is
  the honest figure.

Siting dominates both, by more than the entire reported range.

### Carbon is reported on two bases

They answer different questions and neither is wrong:

- **Location-based** (`IND`, 200–550 gCO2e/kWh) — the grid the facility physically
  draws from. Most of the range is regional spread across US interconnects.
- **Market-based** (`IND`, 20–200 gCO2e/kWh) — after power purchase agreements and
  renewable certificates. Anchored on the ~125 gCO2e/kWh implied by Google's
  published per-prompt carbon and energy figures.

Reporting only the market-based figure would flatter the result; reporting only
the location-based one would ignore procurement that genuinely happened. The
report prints both, location-based first.

### The falsifiers, written before the numbers

These are evaluated in `packages/usage/test/impact.test.ts`, not asserted here.

| | Falsifier | If it triggered | Status |
| --- | --- | --- | --- |
| **F1** | The three methods agree within 2x | The wide band is unjustified; report a narrow one | Does not trigger — they span ~22x |
| **F2** | Method B reproduces the published per-query figures | Method A is redundant; report B alone | Does not trigger — B runs ~5x high |
| **F3** | One term is >90% of the energy | Name that term and drop the rest | Does not trigger — prefill 53%, attention 29% |
| **F4** | Water/carbon are narrower than energy | They are unit conversions, not findings | Does not trigger — both are wider |

F2 is the uncomfortable one and is left visible on purpose. Method B predicts
~1.74 Wh for a typical short chat query against the 0.24–0.34 Wh Google and
OpenAI have published. Part of that gap is real — this is a larger model, and
those are vendor self-reports — and part is bias in method B. Method A exists to
hold the discrepancy in view rather than bury it.

### Determinism

The sampler is seeded and the seed is printed in the report. Re-running on the
same transcripts reproduces the numbers exactly, so a reader can tell a
methodology change from sampling noise. Same discipline as the bench scenario
seeds.

---

## What this does not model

- **Training**, amortised over the model's serving life. Excluded, and it is not
  small.
- **Embodied carbon** of the accelerators, networking, and building.
- **Local compute** — this repository's own test runs, builds, and browser.
- **The network** between the user and the datacentre.
- **Model identity.** The rate card is keyed by model id and refuses an unknown
  one rather than substituting a similar model's rates.
- **A drifting denominator.** The transcripts grow while the report runs, and the
  report's own turns are in its totals. The footer records the moment counted.

---

## Layout

```
packages/usage/src/transcripts.ts   JSONL -> deduplicated token ledger
packages/usage/src/rates.ts         the published rate card (PUB)
packages/usage/src/cost.ts          ledger -> dollars, plus counterfactuals
packages/usage/src/montecarlo.ts    seeded lognormal sampling
packages/usage/src/impact.ts        the constants, the three methods, water, carbon
packages/usage/src/report.ts        the single HTML page
packages/usage/src/cli.ts           entry point
```
