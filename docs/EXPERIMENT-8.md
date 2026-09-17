# Experiment 8 — what a dropped photograph costs, and whether anything notices

**Status: complete for the half that can be measured without a real sphere, and
explicit about the half that cannot.** No solve is run and no image is rendered
here: the subject is the indexing logic, and a deleted file is deleted whether
the picture behind it came off a sensor or a ray tracer.

- **Data** — [`experiments/experiment-8.json`](../experiments/experiment-8.json)
- **Reproduce** — `npm run experiment8` (18 000 trials, about 16 s)
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
is that measurement, for the two cheap ones and for a third the plan named only
in passing.

**That third mechanism exists because of this experiment's first run.** It left
the bookends' blind spot measured and open, and ended by naming the cheapest
thing that could shut it: ask whether a Gray plane and the frame beside it are
still complements of one another. It is now built, and scored here on the same
broken captures as the other two.

## The answer

<!-- generated: experiment-8-headline -->
| mechanism | captures silently wrong | captures carrying a wrong run | runs offered | of those, mis-indexed | mis-indexed per run captured |
| --- | --- | --- | --- | --- | --- |
| ordering alone | 4000 / 10000 (40.0%) | 4000 / 10000 (40.0%) | 16000 | 10688 (66.8%) | 26.7% of 40000 |
| structural bookends | 603 / 10000 (6.0%) | 1233 / 10000 (12.3%) | 23600 | 1367 (5.8%) | 3.4% of 40000 |
| bookends + complement fingerprint | 23 / 10000 (0.2%) | 84 / 10000 (0.8%) | 22317 | 84 (0.4%) | 0.2% of 40000 |
<!-- /generated -->

**Do not read the first column on its own — read it against the second.** The
gap between them is a finding rather than a presentation choice: **a capture a
mechanism refuses can still contain a run it got wrong and offered.** `ok: false`
says some run was rejected; it does not say the rest are sound. For the bookends
that gap is 603 captures against 1233, so the silent-capture column understates
their exposure twofold — 630 trials where the whole-capture verdict looked safe
and a bad run went out anyway.

(That second column is new, and it is new because the sentence it replaces
carried a hand-computed *"factor of three"* while the results file said two.
`trialsWithBadUsableRun` was the one number in the file that no generated table
rendered, which is exactly how it drifted. It is rendered now.)

So the honest unit is the **projector run** — the thing that actually goes into a
bundle adjustment. There are two rates on it, they answer different questions,
and an earlier version of this page reported one under the other's name:

- **Of the runs a mechanism handed back, how many were wrong** — 66.8%, then
  5.8%, then 0.4%. This is what a caller experiences, and each mechanism is
  measured against its own offered total.
- **Wrong runs per run the captures contained** — 26.7%, then 3.4%, then 0.2%.
  This is what a session costs, and it is smaller for a mechanism that refuses a
  lot.

Ordering looks far worse on the first than the second, and the reason is worth
reading rather than smoothing over: on a faulty capture it offers runs **only in
the arms where it noticed nothing at all**, so nearly everything it hands back
there is wrong. It scores well on exposure by refusing the cases it can see and
being blind in the cases it cannot.

## What broke, arm by arm

Faults are injected uniformly and independently over the whole capture: drops
first, then duplicates of what is left. Applying them the other way round would
let a drop delete a frame that had just been duplicated, quietly turning a
two-fault trial into a clean one and flattering every mechanism.

<!-- generated: experiment-8-arms -->
| what went wrong | mechanism | captures silently wrong | runs offered | of those, wrong | runs kept |
| --- | --- | --- | --- | --- | --- |
| nothing went wrong | ordering | 0.0% | 8000 | 0 (0.0%) | 4.00 / 4 |
|  | bookends | 0.0% | 8000 | 0 (0.0%) | 4.00 / 4 |
|  | fingerprint | 0.0% | 8000 | 0 (0.0%) | 4.00 / 4 |
| one frame deleted off the card | ordering | 0.0% | 0 | 0 (—) | 0.00 / 4 |
|  | bookends | 0.0% | 5691 | 0 (0.0%) | 2.85 / 4 |
|  | fingerprint | 0.0% | 5691 | 0 (0.0%) | 2.85 / 4 |
| two frames deleted | ordering | 0.0% | 0 | 0 (—) | 0.00 / 4 |
|  | bookends | 0.0% | 4045 | 0 (0.0%) | 2.02 / 4 |
|  | fingerprint | 0.0% | 4045 | 0 (0.0%) | 2.02 / 4 |
| the remote double-tapped once | ordering | 0.0% | 0 | 0 (—) | 0.00 / 4 |
|  | bookends | 0.0% | 6021 | 0 (0.0%) | 3.01 / 4 |
|  | fingerprint | 0.0% | 6021 | 0 (0.0%) | 3.01 / 4 |
| one frame deleted and one shot twice — the count still adds up | ordering | 100.0% | 8000 | 4473 (55.9%) | 4.00 / 4 |
|  | bookends | 22.7% | 4727 | 454 (9.6%) | 2.36 / 4 |
|  | fingerprint | 1.1% | 4296 | 23 (0.5%) | 2.15 / 4 |
| a thoroughly bad session | ordering | 100.0% | 8000 | 6215 (77.7%) | 4.00 / 4 |
|  | bookends | 7.5% | 3116 | 913 (29.3%) | 1.56 / 4 |
|  | fingerprint | 0.0% | 2264 | 61 (2.7%) | 1.13 / 4 |
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

**And the fingerprint costs nothing to add.** Read the first four arms down the
table: on every capture without a cancelling pair it offers the same runs as the
bookends, keeps the same number, and gets none of them wrong — 8 000, 5 691,
4 045 and 6 021 runs, identical in both rows. It is not a trade of recall for
precision. It refuses strictly more of the captures the bookends were wrong
about and none of the ones they were right about.

## What the fingerprint is, in one paragraph

The emitter plays each Gray plane immediately followed by its own complement, so
in the projector the two add to a flat field. What a camera records is
`a(p) * target(p) + b(p)`, with `a` carrying albedo, the cosine falloff, the
projector gain and the exposure, and `b` carrying ambient and the black floor —
all per-pixel unknowns nothing at this stage can measure. Every one of them
cancels, because that map is **affine** and the two frames were shot back to back
through the same one:

    gray(p) + grayInverse(p) = a(p) + 2 b(p) = white(p) + black(p)

So the run's own white and black frames are the reference, and the check is
whether each pair still reproduces them. A drop and a duplicate that cancel
inside a run shift every frame between them by one position, and a Gray plane
that has moved by one is no longer beside its own complement — so the residual
comes back near a half instead of near zero. The comparison needs a thumbnail per
photograph rather than the photograph, because the identity is pointwise and
linear and therefore survives block-averaging exactly.

**It has one hole and it is a property of the plan, not a threshold.** The plan
pairs the Gray planes with their complements and pairs the phase steps with
nothing. A fault that disturbs no pair is invisible — which in the page's own
plan means the eight phase frames rearranging among themselves. Swept
exhaustively over every way a drop and a duplicate can cancel inside one run
(`packages/bench/test/complements.test.ts`), the mechanism catches **928 of
992**, and the 64 it misses are *exactly* the ones that leave every Gray pair
intact. Closing that would need a second identity — the phase steps of one axis
also sum to a flat field — which is not built here and is a weaker signal, since
a fringe is finer than most Gray planes and so is the first thing a coarse
thumbnail stops resolving.

## What this does not measure

Stated before anyone builds on it.

- **Classification is exact here by construction.** Nothing is rendered, so every
  white frame is unambiguously white and `MIN_CLASSIFY_MARGIN` is never
  approached. In a room the separation is a photometric question: PARAMETERS.md
  §5 leaves the ambient term unmeasured across 1%–15%, and a sphere that fills
  too little of the frame dilutes every reference toward the middle.
  `indexByBookends` refuses below a stated margin rather than segmenting noise,
  and **what that margin costs on real images is not measured by this experiment
  or by anything else in the repository.**

  So every number above is an **ideal-classification baseline**, not an upper
  bound — a distinction review had to correct. Exact classification does bound
  RECOVERABILITY from above: no photometric trouble helps a mechanism place more
  frames correctly. It bounds nothing about the failure rates, because a misread
  reference in a room can break a run's structure and produce an extra REFUSAL,
  lowering the silent rate, or leave it intact and raise it. Neither direction is
  established here.
- **The fault model is an assumption.** A real operator's mistakes are not
  uniform — a spoiled frame is likelier at the start of a run, a duplicate
  likeliest from a double-tapped remote. Modelling that would mean inventing a
  distribution nobody has measured, and the headline would become a property of
  the invention.
- **The fingerprints are exact too, and for the same reason.** They are computed
  from the pattern plan in projector space, with no sphere, no warp and no albedo
  between the emitter and the number, so every complement residual here is either
  0 or the full mismatch. That makes the fingerprint's catch rate an
  **ideal-fingerprint baseline** on exactly the footing of the classification
  above — a reader who discounts one should discount both. What *is* established,
  in `packages/solver/test/indexing.test.ts`, is the part that matters most: the
  affine per-pixel camera term cancels out of the identity, so the check needs no
  photometric constant to be known. What is **not** established is the noise floor
  — how far from zero a correct pair drifts on real photographs — and
  `COMPLEMENT_LIMIT` sits above an unmeasured edge for that reason, exactly like
  `MIN_CLASSIFY_MARGIN`.
- **Mechanism 3 is not here.** Projecting a frame index into the frame itself
  remains unbuilt. It is the expensive one: it spends raster area, and its risk is
  entirely photometric — a marker must survive an oblique sphere in an unmeasured
  room, and there is no one region of a sphere every camera position can see.
  It is also no longer the only thing that tells patterned frames apart from each
  other, which is what changed about the case for it.

## What it decides

**The bookends are worth having and are not sufficient.** For the cost of reading
one number off each photograph they take the runs they hand back from 66.8%
mis-indexed to 5.8%, and the exposure across a whole session from 26.7% to 3.4%
— and on any capture without a cancelling pair they were never wrong at all.
That is enough to soften `docs/CALIBRATE.md`'s shooting rules from *never delete
a frame* to *a spoiled frame costs you that projector's run*, which is the
difference between a rule an operator must not break and a mistake they can
recover from.

It is **not** enough on its own to let the operator stop caring. A capture with
one frame deleted and one shot twice comes back a confidently wrong calibration
22.7% of the time — that being the share of trials where the two faults land in
the same run and cancel — and nothing in the bookends can see it.

**The complement fingerprint closes most of that, and it is the cheap one.** It
takes the same capture from 22.7% silently wrong to 1.1%, the runs it hands back
from 5.8% mis-indexed to 0.4%, and a whole session's exposure from 3.4% to 0.2%.
It buys that by refusing more: on the cancelling arm it keeps 2.15 runs of 4
where the bookends keep 2.36, and on a thoroughly bad session 1.13 against 1.56.
That is the trade in both directions and it is the right way round — a refused
run costs a re-shoot, a mis-indexed one costs a calibration nobody knows is
wrong.

It spends **no raster area**, which is the whole reason it was worth building
before mechanism 3. Its cost is a thumbnail per photograph, and the grid has to
be at least `2^grayBits` blocks per axis or a duplicated fine plane washes out —
a floor that is derived from the plan rather than tuned, and refused rather than
assumed.

So the question mechanism 3 now has to answer is much narrower than before.
It is no longer "is there anything better than 5.8%"; it is whether projecting an
index into the frame is worth its photometric risk to recover the **0.4%** the
fingerprint still offers wrong, and the phase-block faults it cannot see at all.
The cheaper of the two remaining options is the second identity named above,
which costs nothing new to shoot. **Neither question can be answered from a
simulator,** and that has not changed: what these numbers bound is recoverability
under exact photometry, and the room is still unmeasured.
