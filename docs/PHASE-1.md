# Phase 1 — the loop, its instrument, and round 1's verdict

Phase 1 optimises geometry against ground truth the simulator provides for free.
This document records what the loop measured, and one hard-won lesson about the
loop's own instrument that came before any of it.

---

## The instrument problem, and why it had to be fixed first

`docs/ARCHITECTURE.md` defines the stopping condition:

> a round is non-improving when no gate-facing metric's round-over-round change
> exceeds its own run-to-run dispersion across seeds.

Applied literally to round 1, all four gate-facing metrics were non-improving:

| gate | round 0 | round 1 | delta | across-seed dispersion | verdict |
| --- | --- | --- | --- | --- | --- |
| pose_position | 392.33 | 504.31 | +111.98 | 310.55 | indistinguishable |
| pose_rotation | 6.75 | 4.70 | −2.05 | 2.34 | indistinguishable |
| h_center_recovery | 43.17 | 43.17 | +0.00 | 9.25 | indistinguishable |
| grid_displacement | 12.91 | 18.92 | +6.01 | 32.97 | indistinguishable |

**That conclusion is wrong, and the dispersion column says why.** Measured over
five fresh seeds with the code held fixed, the spread of each scored statistic is
**69% to 182% of its own median** — `pose_position` swings 366 → 677 mm with
nothing changed. The instrument cannot resolve a round's effect.

So the stopping condition as written has a defect: **"no metric moved more than
its dispersion" is trivially satisfiable by making the measurement noisy enough.**
A loop scored that way declares convergence on round one, every time, regardless
of what the code did. It is a rule that rewards a bad instrument.

The root cause is the scored statistic. Gates score on the **worst of six
scenarios** — an extreme value of a small sample, about the highest-variance
statistic available. That is the right choice for *judging a build*, where the
worst case should fail you, and the wrong one for *detecting an improvement*.

Two distinct situations look identical in that table and mean opposite things:

- *the numbers stopped moving* → Phase 1 is finished
- *the instrument cannot see whether they moved* → Phase 1 has not started

This was the second.

### The fix: pair the comparison

Capture **once** per (seed, scenario), then solve several ways with one knob
moved. Same rig, same photons, same correspondences wherever the decode is
unchanged. Scenario variance — the thing swamping everything — cancels exactly.

The power difference is not subtle. Unpaired, a 2× effect is invisible under
69–182% dispersion. Paired, two solves differing in a knob that does nothing
agree **to the last digit printed**.

---

## Round 1's verdict, measured paired

Round 1 changed two things in `packages/solver`, both togglable at runtime, so
they could be crossed: 5 seeds × 3 archetypes × 4 solves = **60 solves, 15 cells**.

- **Knob 1** — a *pooled* decode noise estimate, replacing round 0's per-pixel one.
- **Knob 2** — per-camera variance components.

### Knob 2: no effect. My earlier call was wrong.

| | |
| --- | --- |
| median ratio | **1.00×** |
| helped / hurt / neutral | 7 / 6 / 17 |

On an early partial run I reported that this change was harmful and "doubles the
error on handheld", from a single cell reading 0.49×. **It does not replicate:**

| s04-handheld, nb=16 | seed 1 | seed 2 | seed 3 | seed 4 | seed 5 |
| --- | --- | --- | --- | --- | --- |
| ratio | **0.49×** | 1.04× | 0.97× | 1.07× | 1.00× |

Seed 1 was an outlier and I generalised from it after warning, in this same
document's own protocol, against exactly that. The honest verdict is that knob 2
is inert: where `camScale` comes back `[1.00, 1.00, 1.00]` the two solves are
bit-identical, and where it does not, the effect is within seed scatter.

### Knob 1: real, large, and **scenario-dependent along the bias/noise line**

| scenario | what dominates its error | median ratio | helped | hurt |
| --- | --- | --- | --- | --- |
| `s03-high-ambient` | ambient + sensor noise, tripod | **1.65×** | 9 | **0** |
| `s01-nominal` | sensor noise, tripod | **1.77×** | 8 | 2 |
| `s04-handheld` | **camera motion** | **0.89×** | 3 | **7** |

Ratios are old/new, so above 1 means round 1's change helped.

**The mechanism.** Round 0's per-pixel sigma was effectively random — it spread
30× across its own deciles while actual decode error spread 2×, with Spearman ρ
of 0.05–0.20. Since the bundle weights by `1/σ²` and the outlier pass thresholds
on `|r|/σ`, a random sigma discarded good correspondences at random. Pooling
fixes that, and the rejection counts show it: **~21 000–27 000 rejected falls to
~1 000–1 700**, recovering some twenty thousand correspondences per solve.

That is unambiguously good **when the residuals are noise**. It is a liability
when they are **bias**. Under handheld motion the decode error is coherent within
each (camera, projector) pair — A-18 measured it at 4.50 px median against
0.23 px static. A confident, well-pooled sigma then keeps thousands of *biased*
correspondences that the old, badly-calibrated estimator was accidentally
throwing away. Round 1 made the solver better at trusting data that deserved less
trust.

**This also explains the corpus-level regression that started the investigation.**
The bench corpus is handheld from archetype 4 onward, and gates score on the
worst scenario — which is a handheld one. So a change that helps 17 of 20
tripod pairs and hurts 7 of 10 handheld pairs shows up at the corpus level as
`pose_position` 392 → 504 mm. The unpaired view saw only the regression; the
paired view shows a real improvement and a real liability with a clean boundary
between them.

---

## What round 2 should do

**Named contributor: the decode noise estimator does not distinguish bias from
noise, and pooling makes it more confident about both.**

The discriminator is available and cheap: **bias is coherent within a
(camera, projector) pair; noise is not.** The residual field already carries the
evidence — spatial autocorrelation within a pair separates the two without any
new capture, and the progress page's residual scatter shows the distinction by
eye today (structured on handheld, isotropic on tripod).

So the assignment is not "revert knob 1". It is: **estimate the noise pooled, as
now, but detect coherence within each pair and inflate that pair's uncertainty —
or reject it — when the residuals are structured rather than isotropic.** That
keeps the twenty thousand recovered correspondences where they are trustworthy
and declines them where they are not.

Knob 2 stays as it is. It does nothing measurable, and removing inert code is a
tidiness argument, not a Phase 1 argument.

---

## Amendment to the stopping condition

`docs/ARCHITECTURE.md`'s rule needs a precondition, or it will keep declaring
victory on noise:

> A round may only be judged non-improving if the instrument can resolve the
> effect size being claimed. Before comparing rounds, measure the scored
> statistic's dispersion across seeds with the code held fixed. If a round's
> delta is smaller than that dispersion, the correct conclusion is **"not
> measured"**, not **"not improved"** — and the remedy is a paired comparison,
> not another round.

Round-over-round claims in Phase 1 are made on paired measurements from here on.
The unpaired corpus keeps its job: judging a build against §7's gates, where the
worst case *should* be what fails you.
