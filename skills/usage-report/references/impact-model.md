# The impact model

Read this before defending, adjusting, or quoting any environmental number.

**Standing:** the cost half of this skill is measurement. This half is not. Only
the token counts are measured; every constant below is an industry figure or a
declared guess, and the guesses dominate. The band spans roughly an order of
magnitude and the output is marked PROVISIONAL wherever it appears.

## Provenance classes

| Class | Meaning | Risk if wrong |
| --- | --- | --- |
| `MEAS` | Counted from the transcripts | **None** — re-derivable |
| `PUB` | Published by a vendor; checkable | Low |
| `IND` | Industry or government figure for a comparable facility | Moderate — right order, wrong site |
| `ASSUME` | Not published anywhere; chosen by us | **High** — where the estimate breaks |

Most constants below are `ASSUME`. That is the honest state of the art from
outside an operator, and it is why the answer is a band rather than a number.

## Three methods, and why they are pooled not averaged

They share no inputs of consequence, so their disagreement measures something no
within-method error bar can: how much of the answer is unknowable from outside.

| | Method | Route | Standing |
| --- | --- | --- | --- |
| **A** | Vendor-anchored | Published per-query energy, rescaled by this workload's shape | **Floor** — those disclosures cover smaller models |
| **B** | Bottom-up | FLOPs, memory traffic, watts from first principles | Most specific to this workload |
| **C** | Cost-anchored | Bill → gross margin → accelerator-hours → watts | **Ceiling** — assumes every dollar buys power-proportional compute |

The reported band is the three concatenated with equal weight, so the
between-method spread survives into the result instead of being smoothed away.
On one real project the medians were 22, 142 and 480 kWh — a 22× spread, against
about 5× uncertainty within each method. **That gap is the finding.** Averaging
it produces a number with no defensible error bar.

## Method B's four terms

| Term | What it is |
| --- | --- |
| Prefill | Tokens run through the network. Cache reads skip this — that is what the cache buys |
| Attention | Re-reading the whole KV cache once per generated token. Tensor-parallel sharding cancels: each of G accelerators reads 1/G of it |
| Decode | Streaming weights out of memory per output token, amortised over the serving batch |
| Staging | Restoring a persisted KV cache into accelerator memory |

Typical split on a long agentic project: prefill ~53%, attention ~29%, decode
~15%, staging ~3%. Note that cache reads dominate the *bill* while prefill
dominates the *energy* — a read skips the compute and pays mostly in memory
traffic, which is why caching saves proportionally more energy (~25×) than money
(~7×).

## The constants

**Hardware and model** — all `ASSUME` unless noted. `activeParams` (100–600 B/token)
is the single largest unknown. Also `achievedFlops` (2.5–7 ×10¹⁴ FLOP/s),
`acceleratorWatts` (1.0–2.2 kW at load, `IND`), `fleetUtilisation` (0.3–0.8),
`kvBytesPerToken` (8–200 kB — two orders wide because sliding-window or latent
attention cuts it about tenfold and nobody publishes which is in use),
`hbmBandwidth` (1.5–3.5 TB/s, `IND`), `decodeBatch` (16–256), `bytesPerParam`
(1–2), `stagingBandwidth` (15–150 GB/s).

**Vendor anchor** — `publishedWhPerQuery` 0.24–0.34 Wh (`PUB`): Google's median
Gemini text prompt (Aug 2025) and OpenAI's average ChatGPT query (Jun 2025). The
reference query's own shape is `ASSUME`, since neither vendor states it.

**Cost anchor** — `grossMargin` (0.35–0.75), `computeShareOfCogs` (0.55–0.85),
`dollarsPerAcceleratorHour` (1.5–4.0, `IND` — already includes provisioning
slack, so method C does not divide by utilisation).

**Water** (`IND`) — two unrelated quantities summed: `onSiteWue` 0.05–1.5 L/kWh
evaporated for cooling, and `gridWaterIntensity` 0.8–3.2 L/kWh *consumed*
generating the power. Withdrawal is an order larger but mostly returned;
consumption is the honest figure.

**Carbon** (`IND`) — `gridCarbonLocation` 200–550 gCO2e/kWh (the grid the
facility physically draws from) and `gridCarbonMarket` 20–200 (after power
purchase agreements, anchored on the ~125 implied by Google's per-prompt
disclosures).

## Why carbon is reported twice

Location-based and market-based answer different questions and neither is wrong.
Reporting only the market figure flatters the result; reporting only the location
figure ignores procurement that genuinely happened. The report prints both,
location first.

## Grid presets and published regions

`unknown` is the default and stays deliberately wide. Presets compose: pass
`--grid coal-heavy --grid closed-loop-cooling` for both.

`--region <id>` uses Google Cloud's published 2024 per-region figures (`PUB`,
from cloud.google.com/sustainability/region-carbon) rather than a preset band:

| Region | Location | CFE% | gCO2eq/kWh |
| --- | --- | --- | --- |
| `us-east1` | South Carolina | 31% | 576 |
| `us-west3` | Salt Lake City | 33% | 555 |
| `us-central1` | Iowa | 87% | 413 |
| `us-west1` | Oregon | 87% | 79 |
| `europe-north1` | Finland | 98% | 39 |
| `northamerica-northeast1` | Montréal | 99% | 5 |

The published value is an annual average, so it is narrowed to ±15% rather than
pinned — the annual mean is not the hour you ran in. Market-based intensity is
approximated as grid × (1 − CFE).

### The region must be where inference ran

An agent's sandbox is a small CPU container that exists only while a shell is
running. The model runs on accelerators on separate infrastructure — different
hardware, plausibly a different provider and region — and the container has no
visibility into it. Session energy is dominated by inference; the sandbox is
rounding error against it. Its egress IP is a worse guide still, because a NAT
gateway can sit in a different region than the compute.

Attributing a footprint to the region where a shell egresses produces a number
that sounds rigorous and measures the wrong thing. That is worse than the wide
default, because it looks precise. Set `--region` only when the inference
location is genuinely known.

### Is "inference runs where my container runs" a fair assumption?

No, and the usual reasoning for it inverts under arithmetic. Measured on a real
project that moved about 14 GB of payload:

| Force | Magnitude | Share of a $2,498 bill |
| --- | --- | --- |
| Cross-region egress, same continent | $0.14 – $0.28 | 0.006 – 0.011% |
| Inter-continental egress | ~$1.27 | 0.05% |
| One region of added latency | 2.6 – 18 min across the project | <1% of ~44 h spent generating |

Neither force is within three orders of magnitude of shaping a placement
decision. The force that does shape it runs the other way: accelerators are
scarce and geographically concentrated while a one-core sandbox runs anywhere, so
capacity wins — and an idle accelerator at $2–4/hour costs more in one hour than
the project's entire network bill. Cost efficiency argues *against* co-location.

**What does survive is the weaker claim**: same market, for data-residency,
customer-latency and regulatory reasons. That is what `--geo us|eu|nordic` is
for, and it prints itself as ASSUMED in the output because it is an assumption,
not a measurement.

**Better than either: read `inference_geo`.** The API records where inference ran
and `--list` surfaces it. When it reports a geography, use it and assume nothing.
When it reports `not_available`, that is genuine absence of evidence — which is
an argument for the wide default, not for substituting a guess that looks precise.

### When the region is worth asking about

Carbon is energy × grid intensity, and both are lognormal and independent, so on
a log scale their variances add exactly. That makes the decomposition analytic:

| | Spread (p10–p90) | Var(ln) | Share of carbon variance |
| --- | --- | --- | --- |
| Pooled energy | ~36× | 1.96 | **95%** |
| Grid, region unknown (80–600) | 7.5× | 0.37 | 16% |
| Grid, assumed US (79–576) | 7.3× | 0.37 | 16% |
| Grid, exact region known | 1.4× | 0.004 | 0.4% |

Energy dominates under every assumption. Knowing the exact region narrows the
carbon band from ~50× to ~37×, which is real but modest — and notably, assuming
"somewhere in the US" buys almost nothing over knowing nothing, because the US
regional span (7.3×) is about as wide as honest global ignorance.

An earlier version of this model used 200–550 for "unknown", which was **narrower
than the published span of real datacentre regions** and therefore claimed more
knowledge than the label admitted. It has been widened to 80–600.

The practical rule: ask about the region when the answer might be a hydro or
nuclear grid, because that is a 10× move on the headline. Don't ask to
distinguish one US region from another — the energy uncertainty swallows it.

## Falsifiers

Written before any number was produced. None fires the way that would let the
report be simplified.

| | Falsifier | If it triggered | Observed |
| --- | --- | --- | --- |
| **F1** | The three methods agree within 2× | Report a narrow band | They span ~22× |
| **F2** | Method B reproduces the published per-query figures | Method A is redundant | B runs ~5× high |
| **F3** | One term is >90% of the energy | Name it, drop the rest | Prefill 53%, attention 29% |
| **F4** | Water/carbon narrower than energy | They are unit conversions, not findings | Both wider |

**F2 is the uncomfortable one and is surfaced on purpose.** Method B predicts
~1.7 Wh for a typical short query against 0.24–0.34 Wh published. Part of that
gap is real — a frontier coding model is larger than the median prompt those
figures cover, and both are vendor self-reports — and part is bias in method B.
Method A exists to hold the discrepancy in view rather than bury it. If you are
tempted to "fix" B so it matches, don't: that would be tuning against unmeasured
constants, and the report would lose the only external check it has.

## What it excludes

Training amortisation (not small), embodied carbon of the hardware, local
compute, the network, and anything done outside Claude Code. Also note that on a
live session the transcripts grow while the report runs, so the report's own
turns land in its totals.

## Determinism

The sampler is seeded and the seed is printed. Rerunning on the same transcripts
reproduces the numbers exactly, so a reader can tell a methodology change from
sampling noise.
