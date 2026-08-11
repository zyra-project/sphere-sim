# Experiment 3 — photometric sensitivity, and the §8 work order

**Every number in this document is PROVISIONAL.** Every constant swept here is class
`ASSUME` and nobody has measured any of them (PARAMETERS.md §10,
docs/ARCHITECTURE.md's phase gate). Nothing was tuned; the sweep ran once. Its output
is a *measurement priority*, not a quality claim.

- Figure: [`experiments/experiment-3.svg`](../experiments/experiment-3.svg)
- Data: [`experiments/experiment-3.json`](../experiments/experiment-3.json)
- Reproduce: `node packages/experiments/src/cli.ts 3` (about 75 s)

---

## Method, and the one thing that would make the ranking dishonest

Twenty ASSUME-class photometric constants, each swept alone across its plausible range
at nine levels (logarithmic where the range spans a factor of four or more), with
everything else at its PARAMETERS.md nominal. Nine responses measured at each level:
§7's four scored photometric gates, three unscored readings `metrics/photometric.ts`
already reports beside them, and two more borrowed from Experiment 2. Each response is
divided by its own gate before ranking, so a ΔE2000 and a bare fraction share a unit
without anybody choosing a weight.

**The honesty problem.** Each range in `packages/calibration/src/parameters.ts` carries
a `rangeSource`. `'stated'` means PARAMETERS.md gives the range; `'inferred'` means we
invented it (docs/AMENDMENTS.md A-04). A large swing across an invented range is a
statement about our invention. So the two are ranked in **separate tables**, never
interleaved, and the figure draws them in separate panels. Nine of the twenty
constants have a range PARAMETERS.md never states — including all three reflectances,
which §10 ranks fourth of its highest-risk four.

## The headline, in three sentences

1. **No single constant, swept alone across its whole plausible range, moves any §7
   photometric gate past its threshold.** The largest single-constant excursion is the
   black-uplift chromaticity shift reaching 0.82 against a gate of 2.0.
2. **Two of them together nearly do.** At `L_black_G` = 1/300 and `E_amb` = 0.01 —
   both endpoints of *stated* ranges — the black-uplift ratio reaches **1.125 against
   the 1.20 gate** and its chromaticity shift **1.846 against 2.0**. The black-uplift
   gates are decided jointly by the black floor and the room, and by nothing else.
3. **§10's first-ranked risk comes 8th on the scored gates and 1st by an order of
   magnitude on the reading that can see it.** The disagreement is about the gates, not
   the physics.

---

## Ranking — ranges PARAMETERS.md STATES

`scored` is the largest swing over §7's four scored gates, in units of that gate.
`unscored` is the largest over the three reference readings, normalized by the gate
each is reported beside for scale.

| # | constant | § | range | scored | driven by | unscored | driven by |
| ---: | --- | --- | --- | ---: | --- | ---: | --- |
| 1 | `L_black_G` | §3.2 | 1/2000 – 1/300 | **0.317** | black-uplift chroma | 0.34 | divergence chroma |
| 2 | `L_black_B` | §3.2 | 1/2000 – 1/300 | **0.251** | black-uplift chroma | 0.22 | divergence chroma |
| 3 | `E_amb` | §5 | 0.01 – 0.15 | **0.129** | black-uplift chroma | 0 | — |
| 4 | `L_black_R` | §3.2 | 1/2000 – 1/300 | **0.107** | black-uplift chroma | 0.27 | divergence luminance |
| 5 | `γ_G` | §3.2 | 1.9 – 2.5 | 0.015 | seam luminance | **9.41** | divergence chroma |
| 6 | `γ_R` | §3.2 | 1.9 – 2.5 | 0.004 | seam luminance | **6.88** | divergence luminance |
| 7 | `ρ_spec` | §1 | 0 – 0.08 | 0.003 | black-uplift chroma | 0 | — |
| 8 | `γ_B` | §3.2 | 1.9 – 2.5 | 0.001 | seam luminance | **6.55** | divergence chroma |

## Ranking — ranges this project INVENTED (A-04)

**These are not comparable with the table above** and are not merged into it. A row's
swing is a statement about the range we guessed.

| # | constant | § | invented range | scored | unscored |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | `w_width` | §4.5 | 5° – 40° | 0.124 | 0 |
| 2 | `E_amb_chroma` | §5 | 2700 – 6500 K | 0.057 | 0 |
| 3 | `g_B` | §3.2 | 0.85 – 1.15 | 0.021 | **6.10** |
| 4 | `g_G` | §3.2 | 0.85 – 1.15 | 0.012 | **9.29** |
| 5 | `g_R` | §3.2 | 0.85 – 1.15 | 0.004 | **6.75** |
| 6 | `α_spec` | §1 | 0.2 – 0.7 | 0.0009 | 0 |
| 7 | `ρ_B` | §1 | 0.78 – 0.95 | 0.0004 | 0 |
| 8 | `ρ_G` | §1 | 0.80 – 0.95 | 0.0003 | 0 |
| 9 | `ρ_R` | §1 | 0.80 – 0.95 | 0.0002 | 0 |
| 10 | `wp_i` | §3.2 | 5500 – 7500 K | **0** | 0 |
| 11 | `mask_lo` | §4.5 | 50° – 70° | **0** | 0 |
| 12 | `mask_hi` | §4.5 | 60° – 80° | **0** | 0 |

### Three constants read exactly zero, and the reasons differ

- **`wp_i` is inert by construction, not by measurement.** §3.2 itself says the white
  point is "derived from `g`; tracked separately for reporting". The gains *are* the
  white point, so a `whitePointK` field that disagrees with them is over-specified and
  the model correctly ignores it. Nothing needs measuring; the row exists so the zero
  is on the record. → **A-27**.
- **`mask_lo` / `mask_hi` read zero because of where the metrics look, not because the
  mask does not matter.** §7's seam tracks are at |lat| ≤ 50°, inside the mask onset at
  every value in the range, and the black-uplift lattice's worst point is not near the
  mask either. The mask's real consequence is the *unlit-fraction-within-the-mask*
  gate, which is geometric and outside this experiment (and is A-02's and A-10's
  subject). **Do not read this row as "the mask does not matter."**
- **`ρ_R,G,B` is near-zero for a real and interesting reason** — see the §10
  comparison below.

---

## Against PARAMETERS.md §10's "highest-risk four"

| §10's rank | group | measured rank, scored gates | agrees? |
| ---: | --- | ---: | --- |
| 1 | `γ_R,G,B` divergence | **8 of 20** (5th among stated ranges) | **no** |
| 2 | `L_black_R,G,B` | **1** | yes — and it is *better* than §10 said |
| 3 | `E_amb` and its colour temperature | **3** | yes, exactly |
| 4 | `ρ_R,G,B` | **15 of 20** | **no** |

Two disagreements, and each is a finding rather than a correction.

### Disagreement 1 — γ divergence is first, on the reading that can see it

§10 calls per-channel gamma divergence "the mechanism most likely to be visible on a
real sphere". The measurement agrees with §10 about the physics and disagrees about
the gates:

| response | `γ_G` swept 1.9 → 2.5 | gate |
| --- | ---: | ---: |
| §7 seam luminance | 1.21e-3 → 1.51e-3 | 0.02 |
| §7 seam chromaticity | 0.0270 → 0.0297 | 1.0 |
| divergence chromaticity (unscored) | 0 → **9.41 ΔE2000** | *none stated* |

The artifact is enormous — nine ΔE2000 units, where 1.0 is the classic
just-noticeable difference — and **§7's chromaticity gate moves by 0.003 while it
happens.** This is docs/AMENDMENTS.md A-15's thesis, measured from a second and
independent direction: §7 gates a *discontinuity at the hand-over*, §3.2's artifact is
a smooth *band across a 71° overlap*, and no amount of gamma divergence produces the
first.

There is a sharper structural reason, which Experiment 2 found from the geometric side
and which applies here too. At the nominal 20° ramp the two projectors' normalized
weights sit on a **31°-wide plateau at 0.5/0.5** and §7's hand-over is in the middle of
it. In dark or mid-gray content the sum of two equal contributions through two equal
transfer curves is *smooth* across that plateau whatever the transfer curves are. On
this rig geometry, essentially no photometric constant can produce a step where §7
measures one.

**Conclusion: §10's ranking of γ divergence is right and this experiment's scored
ranking is a statement about §7's gate set.** Rank γ first for the visit.

### Disagreement 2 — reflectance is inert because every §7 gate is a ratio

§10 ranks `ρ_R,G,B` fourth, noting it "scales every photometric result". It does — and
every §7 photometric gate is a **ratio** (overlap ÷ single), a **fraction of a local
mean**, or a ΔE between two points on the same surface. A uniform scale factor cancels
in all four. Sweeping `ρ_B` across 0.78–0.95 moves the black-uplift chromaticity by
0.0004 of its gate.

That is not an argument for skipping the measurement — a white-field frame gives it
almost for free, and reflectance sets the absolute brightness a viewer sees, which no
§7 gate is about. It *is* an argument for putting it last in the queue, and for
noticing that §10's phrase "scales every photometric result" is true of the radiance
field and false of the metric set. Note also that ρ has **no stated range** (A-04), so
its rank is doubly weak evidence. → **A-28**.

---

## Interactions: do §10's highest-risk constants compound?

Pairwise two-level factorial over the six largest main effects plus §10's four, four
corners per pair. The interaction term is half the second difference; `compounding` is
its size against the larger of the two main effects. Only rows whose interaction
exceeds 2% of the response's own gate are shown.

| pair | response | main A | main B | interaction | compounding |
| --- | --- | ---: | ---: | ---: | ---: |
| `L_black_G` × `L_black_B` | black-uplift chroma | 0.138 | 0.108 | **−0.262** | 1.90 |
| `L_black_G` × `E_amb` | black-uplift chroma | 0.343 | −0.517 | **−0.236** | 0.46 |
| `L_black_B` × `E_amb` | black-uplift chroma | 0.277 | −0.414 | **−0.195** | 0.47 |
| `L_black_G` × `L_black_R` | black-uplift chroma | 0.156 | −0.001 | **−0.188** | 1.20 |
| `L_black_B` × `E_amb_chroma` | black-uplift chroma | 0.232 | −0.078 | −0.106 | 0.46 |
| `L_black_G` × `E_amb` | black-uplift ratio | 0.040 | −0.062 | −0.034 | 0.55 |

(All in units of the response's gate.)

**Yes, and two ways.**

1. **The three black floors compound with each other more strongly than either acts
   alone** — compounding 1.2–1.9. That is structural: the black-uplift chromaticity
   shift depends on the *differences* between the three floors, so it is an interaction
   by construction and a single scalar black floor cannot stand in for three. §3.2
   already says the uplift is tinted; this quantifies it. **Measuring one channel's
   black floor is nearly useless.**
2. **The black floor compounds with ambient at about half the main effect** (0.46–0.47)
   on both black-uplift gates. §10's #2 and #3 are not separable, which is exactly what
   A-21 argued from the model's structure: the observed uplift ratio is
   `(ambient + n·floor) / (ambient + floor)`, so the floor's visibility is set by the
   room.

The worst corner of the whole design, over every pair:

| response | worst two-constant corner | value | gate |
| --- | --- | ---: | ---: |
| black-uplift ratio | `L_black_G` = 1/300, `E_amb` = 0.01 | **1.125** | 1.20 |
| black-uplift chromaticity | `L_black_G` = 1/300, `E_amb` = 0.01 | **1.846** | 2.0 |
| seam luminance | `E_amb` = 0.01, `γ_B` = 2.5 | 0.0017 | 0.02 |
| seam chromaticity | `E_amb` = 0.01, `γ_B` = 2.5 | 0.031 | 1.0 |

Both black-uplift gates come within 8% of failing at a corner made entirely of
*stated* ranges — a leaky projector in a dark room. Both seam gates stay two orders of
magnitude inside theirs no matter what is done to them.

---

## The recommended measurement priority for §8

Ordered by what the measurement *decides*, not by what is easiest. §8 item numbers are
PARAMETERS.md's own.

| # | Measure | §8 item | Why it is here |
| ---: | --- | --- | --- |
| **1** | **Per-channel black floor, in a dark room** — frames 8 and 9, read per channel rather than as a neutral | items **8, 9** | Ranks 1, 2 and 4 on the scored gates; compounds with itself across channels at 1.2–1.9× the main effect; jointly with ambient it takes the black-uplift gates to within 8% of failing. §8 already calls frames 8–9 "the highest-value pair in the list" — this confirms it and adds that they must be read **per channel** and **together with item 16**. |
| **2** | **Ambient level at the sphere surface**, in the room's real operating condition | items **9, 16** | Rank 3, and it is the other half of every black-uplift number. A-21: whether §7's 1.20 gate passes is mostly a statement about `E_amb`. One lux meter reading. |
| **3** | **Per-channel step wedge on two projectors** → `γ_R,G,B` | item **12** | §10's first-ranked risk, 9.4 ΔE2000 across its stated range on the reading that can see it — and invisible to every §7 gate, which is why it must not be dropped because the gates look green. Item 12 already says "repeat on a second projector if time allows": **do not treat that as optional**, it is the only frame that separates per-channel divergence from per-projector divergence. |
| **4** | **The blend region's width, shape and anchor** — flat mid-gray, darkest room | item **13** | Experiment 2: width is worth 8× in geometric tolerance and shape 1.6×. Its range here is inferred, so its rank in the table above is weak evidence; its rank in Experiment 2 is not. Photograph enough of the overlap to see **where** the crossfade sits, not only how wide it is (A-25). |
| **5** | **Per-channel full-field frames per projector** → `g_R,G,B` | items **10, 11** | Same mechanism as γ: 6–9 ΔE2000 on the divergence readings, ~0.02 of a gate on the scored ones. Its range is invented, so the size of the swing is ours; the *mechanism* is §3.2's and is real. |
| **6** | **Ambient colour temperature** | item **16** | 0.057 of a gate, on an invented range. Cheap — it is the same reading as item 16 with a white card. |
| **7** | **Projector primaries / colour gamut from the datasheet** | item **2** | Not sweepable here because PARAMETERS.md states no value at all (A-22), yet every ΔE2000 in the project rests on the Rec.709 substitution. Free: it is on a page somebody is already reading. |
| **8** | **Sphere reflectance against a reference card** | item **6** | Rank 15 of 20, and every §7 gate is a ratio that cancels it. Worth having for absolute brightness; not worth spending visit time on. |
| **9** | **Specular lobe** `ρ_spec`, `α_spec` | — | 0.003 and 0.0009 of a gate. §1 invites setting `ρ_spec` to zero to test sensitivity; done, and it barely registers. No frame needed. |

### One thing the visit should measure that is not on §8's list

**The mask boundary, against a latitude-labelled pattern.** `mask_lo`/`mask_hi` read
exactly zero here, and that is an artifact of where the photometric metrics sample, not
evidence. A-02 already asks for this and A-10 shows a hard gate depends on it. It is
item 15 with one added requirement: a pattern that lets the boundary be *read off*
rather than inferred.

## What this experiment cannot tell you

- **It sweeps one constant at a time across all projectors together.** So it produces
  *inter-channel* divergence and never *inter-projector* divergence. §3.2's "four lamps
  at different hour counts give four different white points" is the second kind, and it
  is the kind that could in principle produce a genuine step at a seam. Nothing here
  measures it. `divergentTransferSet` exists for it and defaults to zero divergence;
  running it would need a magnitude, which is exactly the unmeasured number this
  experiment is a work order for.
- **Nine of twenty ranges are invented.** For those rows the ranking is conditional on
  our invention, and `scorePerUnitRange` in the results file is the closest thing to a
  range-free comparison available.
- **Every gate it ranks against is itself class ASSUME.** §7 says so. A ranking against
  the wrong thresholds is a ranking of the wrong constants, and the two-corner result
  above is the clearest example: the black-uplift gates are the only ones close enough
  to their thresholds for the ranking to mean anything.

## Proposed amendments

- **A-27 — `wp_i` is a derived quantity and should be marked as one.** §3.2 lists it as
  a parameter with a nominal and a class, and also says it is "derived from `g`". The
  model correctly treats the gains as authoritative and ignores the field, and this
  sweep confirms a sensitivity of exactly zero. Either delete the row or mark it
  `DERIVED` so nobody plans a measurement for it.
- **A-28 — §10's fourth-ranked risk is inert against every §7 gate, and §10's stated
  reason is why.** `ρ_R,G,B` "scales every photometric result", and all four §7
  photometric gates are ratios or local fractions in which a uniform scale cancels.
  Either re-rank it, or state what it *is* load-bearing for (absolute brightness,
  legibility, viewer-adaptation) and gate that instead.
- **A-29 — the black-uplift gates cannot be planned for one constant at a time.** Two
  stated ranges together bring both to within 8% of failing while neither does alone.
  §8's frames 8, 9 and 16 should be described as a single joint measurement whose
  product is `(L_black_R,G,B, E_amb)` as a tuple, rather than as three independent
  items.

## Reproducing

```
node packages/experiments/src/cli.ts 3      # 75 s, writes experiments/experiment-3.{json,svg}
node --test "packages/experiments/test/*.test.ts"
```

`experiments/experiment-3.json` carries every level of every sweep with its full
response vector, per-response monotonicity and gate-crossing checks, the pairwise
interaction design with all four corners of each pair, and the mechanical §10
comparison.
