# Experiment 4 — what the room behind the sphere costs a calibration

**Status: complete, and corrected once after review.** The first published
version of this page was measured correctly and *summarised* wrongly: it reported
ratios of two five-sample medians as if they were effect sizes. The measurements
below are unchanged; roughly half the numbers attached to them are. What changed,
and why, is in §6.

The pose metric is geometric, so the Phase 2 photometric gate does not apply to
it. One photometric constant does enter, and §7 says where.

- **Figure** — [`experiments/experiment-4.svg`](../experiments/experiment-4.svg)
- **Data** — [`experiments/experiment-4.json`](../experiments/experiment-4.json)
- **Reproduce** — `npm run experiment4` (140 solves, about 16 minutes)

---

## The answer

> **A room behind the sphere is fatal to this pipeline, and no setting makes it
> harmless for free.** Putting the structured-light pattern on the room takes the
> recovered pose from **20.6 mm to 7841 mm** on the medians. Paired seed by seed
> — which is the comparison this design actually bought — removing the room is
> worth a **geometric mean of 146×**, it improves **4 of 5** rig draws, and it
> takes the solves no worse than the worst clean solve from **1 back to 5**. The
> cause is that **14.1% of accepted correspondences come back from surfaces that
> are not the sphere**, and those are not noise: the solver's world model has
> exactly one surface, so an off-sphere point is placed on the ball anyway and
> becomes a confident, self-consistent lie the robust loss cannot reject.
>
> Two mitigations work, neither cleanly. **Segmentation** — rejecting a
> correspondence whose projector ray misses the *nominal* sphere — is worth a
> paired geometric mean of **13.6×**, improves **3 of 5** seeds while degrading
> 2, takes usable solves from **1 to 3**, and costs a clean capture nothing
> (1.04×). **Raising the decoder's modulation floor to 0.40** brings the room to
> within 2× of what a clean capture achieves *at that same floor* — but 0.40
> costs a clean capture **2.94×** on its own, so it buys immunity by making
> everything worse, and it leaves a 15 249 mm tail.

Six things must travel with that.

1. **Five rig draws is not five trials.** Every cell is the same five draws, so
   the design is paired and the direction of every effect is solid. What five
   draws cannot do is size an effect that spans four orders of magnitude. Every
   factor above is a point estimate with no resolution behind its digits.
2. **The failure is a coin flip, not a slope.** At the shipped threshold with a
   6 m room the five seeds ran from 15 mm to 40 638 mm. Every raw value is in the
   results file for exactly that reason.
3. **One draw dominates.** Seed 3 owns **15 of the 30** catastrophic runs across
   the whole grid — and seed 3 is the *best* rig on a clean capture, at 12.89 mm,
   the lowest of the five. A rig that looks ideal in an empty room can be the one
   the room destroys, which is why "just run it twice" is not the remedy §5 once
   claimed it was.
4. **This is a property of the pipeline, not of a gallery.** The room is a
   cylinder with a flat floor and ceiling and nothing in it. A real room has a
   guard rail, a plinth, a door and people, all nearer than the wall, so this is
   a floor on the effect rather than a bound.
5. **It was off by default before this experiment and it still is.** Every number
   in `bench-results.json` and in Experiments 1–3 was produced with
   `roomSpill: null`, and `capture.test.ts` asserts that condition is
   bit-for-bit the capture that existed before it.
6. **Segmentation here is geometric, not image-space.** It asks whether a decoded
   projector pixel's own ray reaches the *nominal* sphere, using only what the
   solver already holds. `packages/bench/test/capture.test.ts` proves no ground
   truth reaches it by moving the nominal and watching what it rejects change. It
   is *not* the image-space silhouette detector a real implementation would use,
   and that difference is the largest untested thing on this page.

---

## 1. What the room costs, at the shipped decoder threshold

Five seeds per cell, archetype 1, the bench's `default` preset, ceiling held at
14 feet. Worst projector position error after gauge alignment, in millimetres.

| room | median | min | max | off-sphere share | usable grid metric |
| --- | ---: | ---: | ---: | ---: | --- |
| **none (as published)** | **20.6** | 12.9 | 51.5 | 0.00% | 5/5 |
| wall at 9 m | 146.9 | 24.6 | 80 953 | 10.04% | 5/5 |
| wall at 6 m | 7841 | 15.1 | 40 638 | 14.10% | 4/5 |
| wall at 4 m | 3452 | 21.5 | 346 932 | 16.12% | 3/5 |

**A tenth of the accepted correspondences is enough to destroy the solve.**
`packages/solver/src/bundle.ts` turns a camera pixel into a 3D point by
intersecting the ray with the sphere, and that is the only place a point can come
from. A wall pixel is not rejected; it is *placed* on the ball.

**The grid-displacement metric stops existing before the pose error does.** In
the worst cells it comes back NaN — the recovered rig is so wrong the metric
cannot be evaluated on it. A pipeline reporting only a gate pass/fail would show
a missing number rather than a bad one.

**The ordering by room size is not established.** The medians are non-monotone,
and F3 records that. But the ordering is decided entirely by the 4 m cell, where
every projector lens sits *outside* the wall radius and the room cannot occlude
itself — a geometry the other two rooms do not share. The 9 m → 6 m step is
monotone. With five draws this axis cannot be ordered, and the honest reading is
that every room in the sweep is catastrophic. What *is* monotone is the
contamination: 10.0%, 14.1%, 16.1% as the room closes in.

---

## 2. Why: where the false correspondences come from

Totals over all five seeds, by the surface the camera ray actually hit.

| room | threshold | wall | floor | ceiling |
| --- | ---: | ---: | ---: | ---: |
| 9 m | 0.02 (shipped) | 5378 | 190 | 164 |
| 9 m | 0.10 | 0 | 94 | 105 |
| 9 m | 0.20 | 0 | 50 | 75 |
| 6 m | 0.02 (shipped) | 8190 | 91 | 103 |
| 6 m | 0.10 | 438 | 89 | 103 |
| 6 m | 0.20 | 0 | 50 | 75 |
| 4 m | 0.02 (shipped) | 10 041 | 0 | 0 |

**The wall is the bulk of it and the wall is the easy part.** It is metres of
surface at nine to eleven metres from its projector, so it comes back dim, and a
modulation floor five times the shipped one removes it completely.

**What is left is the floor and the ceiling.** They are two to four metres from
the lenses — *nearer than the sphere* — so they return as much modulation as the
ball does. This is the mechanism behind §3: a brightness test cannot separate two
populations that are the same brightness, so the only floor that removes them is
one high enough to start removing the sphere too.

**The 6 m and 9 m rooms give identical rows above 0.02, and that is not a bug.**
Once the wall is rejected the survivors are floor and ceiling, and those are the
same two surfaces in both rooms. `packages/bench/test/capture.test.ts` pins the
geometry that makes it so.

---

## 3. The threshold: it works, by making everything worse

Sweeping the decoder's absolute modulation floor, `minModulation`, from its
shipped 0.02. Median pose error in millimetres; the seed range in brackets.

| threshold | no room | wall at 6 m | room ÷ clean, same floor |
| --- | ---: | ---: | ---: |
| **0.02 (shipped)** | **20.6** [12.9 – 51.5] | **7841** [15.1 – 40 638] | 380× |
| 0.10 | 20.6 [12.9 – 51.5] | 49.1 [18.7 – 89 538] | 2.4× |
| 0.20 | 33.2 [12.1 – 47.4] | 515.6 [12.1 – 172 442] | 15.5× |
| 0.40 | 60.8 [46.4 – 63.3] | 62.9 [53.9 – 15 249] | **1.03×** |

**F4 is not triggered: a floor does separate them.** At 0.40 the room adds almost
nothing — 62.9 mm against a clean 60.8 mm at the same floor. The first version of
this page said no floor separated them, because it compared every room cell
against the clean capture *at the shipped floor*. Raising the floor costs a clean
capture too, so that bar was arithmetically unreachable over the top of its own
sweep. A falsifier that cannot fail measures nothing; the bar now moves with the
floor, and `run.ts` carries the reasoning.

**But it is not a fix, and the corrected result says so more clearly than the
broken one did.** Reaching that immunity costs a clean capture a factor of
**2.94** — 20.6 mm becomes 60.8 mm — because the floor starts rejecting genuine
sphere pixels at grazing incidence, which are exactly the ones that constrain the
limb. And the tail does not go away: the worst seed at 0.40 with a room is still
15 249 mm. What the threshold buys is not a good calibration in a room; it is an
equally bad calibration either way.

**Read the brackets, not the medians.** At 0.10 the median is 49 mm and the worst
seed is 89 metres. Reporting the median alone would make this table look like a
fix at every row.

---

## 4. Segmentation

Reject a decoded correspondence when the projector's own ray, from its
**nominal** pose through the decoded pixel, does not reach a sphere of §1's
radius at the world origin. The margin inflates that test sphere. All cells at
the shipped decoder threshold; median pose error in millimetres, seed range in
brackets.

| room | no segmentation | margin 0 | margin 0.05 | margin 0.15 | best |
| --- | ---: | ---: | ---: | ---: | :--- |
| **none** | **20.6** [12.9 – 51.5] | 21.4 [9.2 – 42.6] | 20.6 [12.9 – 42.3] | 20.6 [12.9 – 51.5] | 0.05 |
| wall at 9 m | 146.9 [24.6 – 80 953] | 102.8 [25.8 – 7282] | 3517 [7.0 – 36 455] | 1037 [14.8 – 376 452] | 0 |
| wall at 6 m | 7841 [15.1 – 40 638] | **44.0** [18.8 – 352 389] | 52.8 [7.0 – 109 639] | 282.5 [17.8 – 155 988] | 0 |
| wall at 4 m | 3452 [21.5 – 346 932] | 42.0 [15.1 – 917] | 410.1 [21.4 – 64 474] | **41.3** [20.8 – 1299] | 0.15 |

**It is worth a paired geometric mean of 13.6×, and F5 still triggered.** F5 asked
whether segmentation leaves the room costing more than twice the clean baseline.
At 6 m the median is 44.0 mm against a baseline of 20.6, which is 2.14× — so F5
triggered. The first version of this page called that "by seven percent". It is
not: at n=5 that cell's median could only ever have been one of 18.8, 21.5, 44.0,
166.8 or 352 389 mm, so there is no resolution behind a seven-percent margin. The
criterion was written before the sweep and fired; the effect size is reported
beside it, because a threshold verdict says nothing about the size of an effect.

**Zero margin is the right default, and the first version of this page argued it
too hard.** It said the measurement was "wrong at every room size". The file's own
4 m row contradicts that: 41.3 at margin 0.15 beats 42.0 at margin 0, and on a
clean capture 0.05 beats 0. Margin 0 is best at **two of four** room sizes, and an
argmin over three noisy medians is not a measurement of which margin is best. What
survives is weaker and still useful: **no margin beat zero by enough to matter,
and the mechanism against large margins is real.** A ray passing between `R` and
`(1 + m)R` misses the real ball and travels on to the far wall, landing metres
away while its projector coordinate sits exactly at the silhouette edge — the most
damaging outlier available. `DEFAULT_SEGMENTATION_MARGIN` is 0 as the conservative
choice, not as a measured optimum.

**On a clean capture it costs nothing.** Margin 0 rejects about 3400
correspondences per capture and the pose is 21.4 mm against 20.6 — a factor of
1.04, inside the seed range. F6 did not trigger. The points it removes are
grazing-incidence decodes at the limb, the least certain in the set.

**What survives is the chicken-and-egg, made numerical.** At margin 0 with a 6 m
room, 0.80% of accepted correspondences are still off the sphere: the ones whose
projector ray misses the TRUE sphere and hits the NOMINAL one, displaced by the
mount error the solve exists to find. Two of five seeds still get worse, one of
them from 2500 mm to 352 389 mm.

---

## 5. The falsifiers, and what happened to each

Written into `packages/experiments/src/spill/design.ts` before the sweep ran;
`judge()` evaluates these and the booleans are in the results file.

| # | Falsifier | Outcome |
| --- | --- | --- |
| F1 | The condition is inert — the wall never clears `minModulation` | **Not triggered.** 14.1% of accepted correspondences came from off the sphere |
| F2 | The robust loss absorbs it — the pose does not move | **Not triggered.** Paired, the room costs a geometric mean of 146× and degrades 4 of 5 seeds |
| F3 | The cost is not monotone in room size | **Triggered**, but decided entirely by the 4 m cell, whose lenses sit outside the wall. The 9 m → 6 m step is monotone and the axis is unorderable at n=5 |
| F4 | No modulation floor separates the two populations | **Not triggered.** 0.40 does separate them — at 2.94× on a clean capture, and with a 15 249 mm tail |
| F5 | Segmentation does not recover the solve either | **Triggered.** 2.14× the clean baseline against a 2× bar, while improving the paired geometric mean by 13.6× |
| F6 | Segmentation costs a clean capture | **Not triggered.** 1.04×, inside the seed range |

Two of the six triggered. F4 is the one that changed under review, and it changed
in the direction that makes the finding sharper rather than softer: the threshold
is not powerless, it is merely not free, and "not free" is a number rather than a
shrug.

---

## 6. What this page got wrong the first time

An adversarial review round went looking for defects in this experiment and found
four that shared one cause. They are recorded here rather than quietly fixed,
because a results page that silently changes its numbers is worth less than one
that says which numbers moved.

**The design is paired and the estimator threw the pairing away.** `seedFor()`
depends only on the seed index and never on the cell, so all 28 cells are the
same five rig draws. Every headline quantity was nonetheless computed by dividing
two *independently sorted* medians. At n=5 a median **is** one observation, so a
ratio of two medians is a ratio of two arbitrary seeds. The published "factor of
178" was seed 1's 7840.59 mm over seed 1's 44.01 mm.

| quantity | as published | paired |
| --- | ---: | ---: |
| the room's cost | 380× | **146×**, 4 of 5 seeds worse, usable 5 → 1 |
| segmentation's benefit | 178× | **13.6×**, 3 of 5 seeds better, usable 1 → 3 |

`judge()` now reports both, the paired figure beside the ratio of medians rather
than instead of it. It deliberately adds no confidence interval:
`experiment1/stats.ts` argues that a standard error at n≤5 is "a number with a
confidence interval wider than itself", and that argument is right. Pairing is a
different thing — information the design already bought.

**F6 was never evaluated.** It was keyed on the margin that *recovered* the solve,
which is null exactly when F5 fires — which it did. The published run carried
`segmentationCostToACleanCapture: null` while this page reported F6 as "not
triggered" from a number computed by hand. It is now keyed on the best margin and
always produces a number.

**F4's bar was unreachable**, as §3 describes.

**The archived seeds could not reproduce the run.** The results writer rounded
every number to six significant figures, including the seeds: 996363085 was
written as 996363000. Fixed; seeds are now exact.

---

## 7. What this experiment cannot tell you

- **The size of any of these effects.** Five rig draws fix the direction and not
  the magnitude. Every factor on this page would move if the sweep were repeated
  at n=30, and the cheapest useful next measurement is exactly that, over the
  three headline cells only.
- **How much contamination a real room produces.** An off-sphere return is scaled
  by `ρ_room` before it meets the decoder gate. `ρ_room` is **0.3, class ASSUME**
  — nobody has measured a wall. The pose consequence *of* contamination is
  measured; the dose is assumed. A matte-black surround attacks the dose
  multiplicatively across near and far surfaces at once, which is a different
  mechanism from the threshold in §3 and is untested here. It is also Phase 2
  work: tuning against an unmeasured constant is what the phase gate exists to
  prevent, so that measurement belongs in a real room with a photometer.
- **Whether iterating helps.** The residue that survives segmentation is
  precisely the part that depends on the nominal being wrong, so segment → solve
  → re-segment → re-solve should shrink it. Untested.
- **How an image-space segmentation would compare.** The one measured here is
  geometric and inherits a dependence on the nominal rig being roughly right. A
  silhouette found in the photograph would not. This project has not built one,
  and it is the most important open item on this page.
- **Whether segmentation survives a badly wrong nominal.** Every cell uses
  archetype 1, whose documented calibration is close. The `long-throw` archetype,
  where the documented distance is nearly a metre out, is exactly where a
  geometric segmentation should be expected to struggle, and is untested.
- **What a real gallery costs.** One cylinder, two ASSUME constants, no
  furniture, no occlusion, no second bounce. Light reaches the room and stops.
- **Whether more cameras help.** Experiment 1 found the camera-count knee at
  three on a clean capture; the cells here hold the camera count fixed.

---

## What to tell someone doing this for real

1. **Segment before you solve.** Rejecting the correspondences whose projector ray
   misses the nominal ball is a few lines and it is the difference between one
   usable calibration in five and three in five.
2. **Test against the nominal radius, not an inflated one.** No margin beat zero
   by enough to matter, and the mechanism against large margins — rays grazing
   past the limb onto the far wall, carrying silhouette-edge coordinates — is
   real.
3. **Do not reach for `minModulation` first.** A floor high enough to remove the
   room is high enough to cost a clean capture a factor of three, and it still
   leaves a tail.
4. **Then check the tail, and do not trust a single run.** Segmentation leaves
   0.8% contamination and two seeds in five still get worse. But note that
   re-running does not diagnose it: the rig that failed worst here is the one that
   looked best on a clean capture.
5. **Consider segmenting again after the first solve.** The residue is exactly the
   correspondences that miss the true sphere and hit the nominal one, so a second
   pass with the recovered rig should shrink it. Untested here.
6. **A missing grid-displacement number is a worse signal than a large one.** In
   the failing cells the metric could not be evaluated at all.
