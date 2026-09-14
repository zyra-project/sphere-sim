# Experiment 8 — what a dropped photograph costs, and whether anything notices

**Status: complete for the half that can be measured without a real sphere, and
explicit about the half that cannot.** No solve is run and no image is rendered
here: the subject is the indexing logic, and a deleted file is deleted whether
the picture behind it came off a sensor or a ray tracer.

- **Data** — [`experiments/experiment-8.json`](../experiments/experiment-8.json)
- **Reproduce** — `npm run experiment8` (12 000 trials, under a second)
- **Code** — [`packages/solver/src/indexing.ts`](../packages/solver/src/indexing.ts),
  [`packages/experiments/src/indexing/`](../packages/experiments/src/indexing/)

---

## Why it exists

`docs/OPERATOR-PATH.md` Phase 2 is the crux of the operator path: if software can
work out which pattern a photograph shows, tethering leaves the critical path and
an operator shoots however they like and drops the files in. If it cannot, every
operator needs a camera SDK working on their own machine, and most will stop
there.

The plan names three candidate mechanisms and is explicit that the phase **picks
by measurement, not by argument** — *the failure mode of choosing on plausibility
is a capture that works in a dark room in one building and not in another.* This
is that measurement, for the two cheap mechanisms.

## The answer

<!-- generated: experiment-8-headline -->
| mechanism | captures silently wrong | projector runs offered wrong |
| --- | --- | --- |
| ordering alone | 4000 / 10000 (40.0%) | 10688 / 40000 (26.7%) |
| structural bookends | 603 / 10000 (6.0%) | 1367 / 40000 (3.4%) |
<!-- /generated -->

Read the **second** column, not the first. The share of captures that come back
without a complaint flatters the bookends by a factor of three, and the reason is
a finding rather than a presentation choice: **a capture the bookends refuse can
still contain a run they got wrong and offered.** `ok: false` says some run was
rejected; it does not say the rest are sound. That happened in 630 trials where
the whole-capture verdict looked safe.

So the honest unit is the **projector run** — the thing that actually goes into a
bundle adjustment — and the honest question is how many of them arrive carrying a
wrong answer with a clean bill of health.

## What broke, arm by arm

Faults are injected uniformly and independently over the whole capture: drops
first, then duplicates of what is left. Applying them the other way round would
let a drop delete a frame that had just been duplicated, quietly turning a
two-fault trial into a clean one and flattering every mechanism.

<!-- generated: experiment-8-arms -->
| what went wrong | mechanism | silently wrong | runs offered wrong | runs kept |
| --- | --- | --- | --- | --- |
| nothing went wrong | ordering | 0.0% | 0 (0.0%) | 4.00 / 4 |
|  | bookends | 0.0% | 0 (0.0%) | 4.00 / 4 |
| one frame deleted off the card | ordering | 0.0% | 0 (0.0%) | 0.00 / 4 |
|  | bookends | 0.0% | 0 (0.0%) | 2.85 / 4 |
| two frames deleted | ordering | 0.0% | 0 (0.0%) | 0.00 / 4 |
|  | bookends | 0.0% | 0 (0.0%) | 2.02 / 4 |
| the remote double-tapped once | ordering | 0.0% | 0 (0.0%) | 0.00 / 4 |
|  | bookends | 0.0% | 0 (0.0%) | 3.01 / 4 |
| one frame deleted and one shot twice — the count still adds up | ordering | 100.0% | 4473 (55.9%) | 4.00 / 4 |
|  | bookends | 22.7% | 454 (5.7%) | 2.36 / 4 |
| a thoroughly bad session | ordering | 100.0% | 6215 (77.7%) | 4.00 / 4 |
|  | bookends | 7.5% | 913 (11.4%) | 1.56 / 4 |
<!-- /generated -->

Three things in that table are worth naming.

**Ordering alone is not a weak detector; on half the arms it is not a detector.**
Its only check is the total count, so a capture where drops and duplicates
balance passes it every time. That is not a tuning problem — 100% is what the
arithmetic gives, and it is why `docs/CALIBRATE.md` has to tell an operator never
to delete, skip or re-shoot a single frame.

**The bookends stop a fault spreading, and that is structural.** Under ordering,
one frame dropped from the first projector's run mis-indexes every frame of every
projector after it. Under the bookends each run is re-synchronised by its own
white and black frames, so the damage stops at the next boundary. It follows from
re-finding the boundary rather than counting from the start, so it is a property
rather than a rate.

**The bookends' blind spot is exactly one case.** A drop and a duplicate that
cancel *inside one run*, both landing on patterned frames: the count between the
boundaries is unchanged, and every frame's kind is unchanged, because a lit-pixel
fraction cannot tell one Gray plane from another. On the four arms that cannot
produce a cancelling pair — a clean capture, one drop, two drops, one duplicate —
the bookends offered **zero** wrong runs across 8 000 trials.

That last point is the whole design tension in one line. The property that makes
the references separable — a white frame lights the crescent, a black frame
lights none, and *every patterned frame lights about half* — is the same property
that makes patterned frames interchangeable.

## What this does not measure

Stated before anyone builds on it.

- **Classification is exact here by construction.** Nothing is rendered, so every
  white frame is unambiguously white. In a room the separation is a photometric
  question: PARAMETERS.md §5 leaves the ambient term unmeasured across 1%–15%,
  and a sphere that fills too little of the frame dilutes every reference toward
  the middle. `indexByBookends` refuses below a stated margin rather than
  segmenting noise, and **what that margin costs on real images is not measured
  by this experiment.** Every number above is therefore an upper bound.
- **The fault model is an assumption.** A real operator's mistakes are not
  uniform — a spoiled frame is likelier at the start of a run, a duplicate
  likeliest from a double-tapped remote. Modelling that would mean inventing a
  distribution nobody has measured, and the headline would become a property of
  the invention.
- **Mechanism 3 is not here.** Projecting a frame index into the frame itself is
  the one mechanism that closes the blind spot, because it is the only one that
  tells patterned frames apart from each other. It is also the expensive one: it
  spends raster area, and its risk is entirely photometric — a marker must
  survive an oblique sphere in an unmeasured room, and there is no one region of
  a sphere every camera position can see.

## What it decides

**The bookends are worth having and are not sufficient.** They turn 26.7% of
offered runs into 3.4% for the cost of reading one number off each photograph,
and on any capture without a cancelling pair they were never wrong at all. That
is enough to soften `docs/CALIBRATE.md`'s shooting rules from *never delete a
frame* to *a spoiled frame costs you that projector's run*, which is the
difference between a rule an operator must not break and a mistake they can
recover from.

It is **not** enough to let the operator stop caring. A capture with one frame
deleted and one shot twice comes back a confidently wrong calibration 22.7% of
the time — that being the share of trials where the two faults land in the same
run and cancel — and nothing in this mechanism can see it.

So the next question is not "is mechanism 3 better" — it obviously is — but
whether its photometric risk is smaller than a 3.4% poisoned-run rate. **That
cannot be answered from a simulator**, and this experiment is the argument for
answering it on a real sphere rather than by building the expensive option on a
hunch. A cheaper candidate exists and is untested: a per-frame fingerprint that
asks whether a Gray plane and its neighbour are still complements of one another,
which would close the same hole without spending raster area.
