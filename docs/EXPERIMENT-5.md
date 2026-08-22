# Experiment 5 — segmenting the sphere in the photograph instead of in the geometry

**Status: complete. Measured once, not iterated.** Purely geometric metric — a
recovered pose against ground truth — so the Phase 2 photometric gate does not
apply to it. See §5 for the one photometric constant in the neighbourhood and
why it matters far less here than it did in experiment 4.

- **Figure** — [`experiments/experiment-5.svg`](../experiments/experiment-5.svg)
- **Data** — [`experiments/experiment-5.json`](../experiments/experiment-5.json)
- **Reproduce** — `npm run experiment5` (270 solves, about 70 minutes, checkpointed per seed and fingerprinted against the code that measured them)

---

## The answer

> **Image-space segmentation puts the room case back on top of the clean case,
> tail and all.** With a 6 m room present, rejecting camera pixels the photograph
> says are not the sphere takes the recovered pose from a median of **3650 mm to
> 26.3 mm** against a clean baseline of **24.4 mm** — a paired geometric mean of
> **213×** over 30 rig draws, improving **29 of 30**. The geometric test measured
> in experiment 4 is worth **7.7×** on the same draws. Head to head, image-space
> beats it by **28×** and wins on **26 of 30** seeds.
>
> The number that matters most is not a factor. Counting solves no worse than the
> worst clean solve, which the data sets rather than anybody choosing it:
>
<!-- generated: experiment-5-usable -->
> | | usable solves |
> | --- | --- |
> | clean capture, no room | 30 / 30 |
> | room, no segmentation | **3 / 30** |
> | room, geometric segmentation | 11 / 30 |
> | room, image-space segmentation | **28 / 30** |
>
> _The bar is this archetype's own worst clean solve, 51.9 mm — set by the data rather than chosen._
<!-- /generated -->
>
> **The tail is gone.** The room's worst seed is 1 199 120 mm and the geometric
> test still leaves a 348 115 mm seed. Image-space segmentation's worst of thirty
> is **53.8 mm**, against the clean capture's own worst of 51.9 mm. It does not
> reduce the catastrophic failures; it removes them.
>
> **And the reason given for that advantage is wrong.** The argument was causal:
> the geometric test consults the nominal rig, so it should suffer when the
> nominal is bad. The `long-throw` archetype hands the operator 5.18 m when truth
> is 6.14 m — a nominal 0.96 m out — and there the geometric test gets **better**,
> not worse: paired recovery against the room rises from 7.7× to 40.1×, and the
> contamination it fails to remove falls from 1.19% to 0.21%. Image-space stays
> ahead on both archetypes but its margin collapses from **27.7× to 1.13×**.
> Falsifier G6 triggered. §4 is what that costs the conclusion.

---

## 1. What each arm did

Thirty seeds per arm, archetype 1, `default` preset, shipped decoder threshold.
Every arm is the same thirty rig draws — `seedFor` depends only on the seed
index — so every comparison here is paired. Worst projector position error after
gauge alignment, in millimetres.

<!-- generated: experiment-5-arms -->
| arm | median | min | max | off-sphere share |
| --- | ---: | ---: | ---: | ---: |
| no room, no segmentation | 24.4 | 7.8 | 51.9 | 0.00% |
| room, no segmentation | 3 650 | 15.1 | 1 199 120 | 16.86% |
| room, geometric segmentation at margin 0 | 446.0 | 9.9 | 348 115 | 1.19% |
| **room, image-space segmentation** | **26.3** | 6.8 | **53.8** | **0.00%** |
| no room, image-space segmentation | 22.6 | 7.0 | 58.5 | 0.00% |
<!-- /generated -->

And the same four conditions on `long-throw`, whose handed-over nominal is 0.96 m
from truth. Note the clean row: this archetype is simply harder, and millimetres
here are not comparable with the table above.

<!-- generated: experiment-5-long-throw -->
| arm | median | min | max | off-sphere share |
| --- | ---: | ---: | ---: | ---: |
| no room, no segmentation | 219.8 | 21.0 | 617.8 | 0.00% |
| room, no segmentation | 9 110 | 34.4 | 1 735 620 | 10.81% |
| room, geometric segmentation at margin 0 | 128.9 | 42.7 | 1 136 | 0.21% |
| **room, image-space segmentation** | **142.9** | 43.5 | **458.0** | **0.00%** |
<!-- /generated -->

**Contamination goes to zero, not merely down.** The geometric test leaves 1.19%
of accepted correspondences coming from surfaces that are not the sphere. The
image-space test leaves none that the ground-truth ray cast can find, in any of
the thirty draws. That is the whole mechanism: experiment 4 showed that a tenth
of a percent of confident lies is enough to move a pose, and this removes the
population rather than thinning it.

**Why the geometric test cannot do this, restated as a number.** Its residue is
the correspondences whose projector ray misses the TRUE sphere and hits the
NOMINAL one — displaced by exactly the mount error the solve exists to find. It
is a segmentation that depends on the answer. The image-space test reads pixels:
no rig, no pose, no radius, no camera model. `packages/solver/src/silhouette.ts`
has no access to any of them, so it cannot inherit the dependence and it cannot
leak ground truth into the solve. That is a property of what it imports, not of a
test asserting good behaviour.

**It is free on a clean capture.** With no room at all it lands at 22.6 mm
against the baseline's 24.4 — a factor of 0.92, inside the seed range and if
anything slightly better, because the pixels it discards at the limb are
grazing-incidence decodes that were never the well-constrained ones.

**Correction — this page and its results file had never agreed, and the first
correction made it worse.** A code review found that the figure's centre marker
took the *upper* of the two middle observations rather than their mean, which at
thirty seeds is not the median. That was real and is fixed; there is one
`medianOf` in the codebase now, imported by both the runner and the plot. But the
correction written from it quoted numbers that matched neither the old results
file nor the new one, and checking afterwards showed the ORIGINAL page had not
matched its results file either, at any commit — the page was written from one
run and the file regenerated from another, and nothing compared them.

Three transcription failures in one document is a process failure rather than
three accidents, so the tables above are no longer transcribed. They are
generated from `experiments/experiment-5.json` by `tools/experiment-tables.ts`,
between marker comments, and `npm run check:docs` fails the build if a table and
its results file disagree. What that does not cover is prose: a sentence quoting
a figure is still a person writing a number down, which is why this page now
quotes few of them and takes those from the machine-written `verdict.statement`.

**Re-measured under a corrected solver.** A self-review of `packages/solver`
found that `ransacDlt` drew its six-point minimal sample WITH replacement, so
about one bootstrap iteration in 133 built a twelve-column system from fewer than
six distinct constraints. Fixing it changes which six points each iteration
draws, so every arm on this page was measured again rather than left standing.

Nothing on this page concludes differently. The falsifier verdicts are identical
— G4 and G6 triggered, the other five not — image-space is still ahead on both
archetypes, still the only one of the two that drives contamination to zero, and
still nearly tied with the geometric test on the hard archetype. What moved is
every factor: image-space's paired recovery from 340× to 213×, the geometric
test's from 14.7× to 7.7×, and the head-to-head from 23× to 28×. Experiment 4
found the same pattern and localised it: on a clean capture the bootstrap reaches
the same basin whatever it samples, and on a contaminated one the bootstrap is
what CHOOSES the basin. Every arm on this page with a room in it is therefore
sensitive to a change nobody would expect to matter, which is the strongest
statement this project has yet made about how much confidence these factors
deserve. §6's first bullet said the size of the advantage should be treated as
unknown for any rig not measured here. It should be treated as approximate even
for this one.

---

## 2. How it works, and the one thing it assumes

Take the all-projectors-on frame minus the all-off frame. Threshold it with
Otsu — chosen because it takes no constant from anybody, and this project has
already written a page on what an unmeasured constant costs. Label the
foreground into 8-connected components. **Discard every component that runs into
the frame edge, and keep the largest of what remains.**

That last sentence is the entire discriminator, and it is one assumption: **the
ball is framed and the room is not.** A room fills the background and sweeps off
the edges of the picture; a sphere someone aimed a camera at does not touch them.

Two details matter.

**The union across projectors is doing real work.** A single projector lights a
*crescent* of the ball, and a crescent is not distinguishable from a lit patch of
floor by shape. The mask is therefore built per camera from every projector at
once, which is why `captureAndDecode` renders a camera's pairs before decoding
any of them. This is not a simulator trick: it corresponds to one extra
photograph with everything switched on, which is a thing a person standing in the
room can take.

**The detector says when it is unsure.** `segmentSphere` returns every component
it found, which one it chose, and warnings — when nothing is interior, or when the
runner-up interior component is at least half the winner's size, meaning area
decided rather than the border rule. Those warnings are counted per run and are
falsifier G4, and **the assumption did fail — once in 90 image-space runs.** On
`long-throw` seed 26, one of three cameras saw no lit component that stayed clear
of the frame edge, because from that viewpoint the ball is not fully framed. The
detector refused: it masked nothing and said why.

That is the designed behaviour and it is still a cost. A silhouette detector that
silently returned the floor would be worse than none — the floor it hands the
solver is a self-consistent lie of exactly the kind experiment 4 measured — but a
refusal means that camera contributed no correspondences at all, and nothing in
the pipeline told anyone except this counter. A real implementation has to decide
what to do with a camera that cannot see a framed sphere, and this one has no
answer beyond declining to guess.

---

## 3. The falsifiers

| # | Falsifier | Outcome |
| --- | --- | --- |
| G1 | It does not reduce contamination below the geometric test | **Not triggered.** 0.00% against 1.19% |
| G2 | It does not beat the geometric test on pose, paired | **Not triggered.** Paired geometric mean 27.7 |
| G3 | It costs a clean capture | **Not triggered.** 0.92×, inside the seed range |
| G4 | Its framing assumption fails somewhere | **TRIGGERED.** 1 of 90 runs — long-throw seed 26, one camera, ball not fully framed |
| G5 | The win is not consistently signed | **Not triggered.** 26 of 30 seeds |
| G6 | The geometric test does not degrade on a bad nominal | **TRIGGERED.** It improved — see §4 |
| G7 | The image test degrades on a bad nominal | **Not triggered** on the pre-registered measure, but see §4: on a bar-free measure it loses a great deal of ground |

Three of the seven triggered. G4's is worth a note on how it was found: the
counter behind it was originally scoped to the archetype-1 arms only, so the first
version of this page reported zero failures — the failure was in the arm the
counter did not look at. It counts every arm that runs the detector now.

The first five were written before the archetype-1 sweep, the last two before the
long-throw arm. One cut belongs with them rather than in an appendix: **seed 0
was run before G1–G5 were written** — wiring a new detector into the bench needs
one end-to-end run to know it works at all, and that run produced numbers (9.6 mm
at 0.00% contamination). They are phrased so no single draw can satisfy any of
them, but they are not blind, and the honest reading is that G1–G5 are
pre-registered against the other 29 seeds. G6 and G7 are blind. Five of the seven passing would be a comfortable result and it is
not the one to take away: G6 is the load-bearing one, because it tested the
*reason* rather than the effect.

---

## 4. The explanation was wrong, and long-throw is how we know

The argument for preferring image-space segmentation was causal, and it is stated
plainly in §1 and in the module docstring: the geometric test consults the
nominal rig, so it should suffer exactly where the nominal is bad. `long-throw`
is that case — truth 6.14 m, handed-over nominal 5.18 m, an error of 0.96 m.

**The prediction failed in both directions.**

<!-- generated: experiment-5-archetypes -->
| | archetype 1 | long-throw |
| --- | ---: | ---: |
| geometric: paired recovery vs the room | 7.7× | **40.1×** |
| image-space: paired recovery vs the room | 213.1× | **45.6×** |
| head to head (image ÷ geometric) | 27.7× | **1.13×** |
| geometric: contamination it fails to remove | 1.19% | **0.21%** |
<!-- /generated -->

The geometric test did not degrade on a nominal a metre out. It got better, on
the dimensionless measure and on the mechanism both — it leaves *less*
contamination there, not more. Whatever limits it on archetype 1, being handed a
wrong nominal is not it, and the sentence in §1 that says otherwise is
unsupported by the only measurement that tested it.

**A confound in the pre-registered measure, found after the fact and reported
because it changes how G6 and G7 read.** G6 and G7 are judged on the share of
seeds meeting each archetype's *own* worst clean solve. That bar is 51.9 mm for
archetype 1 and **617.8 mm** for long-throw — twelve times looser, because
long-throw is a genuinely harder archetype whose sphere subtends 19° and whose
distance and field of view are nearly degenerate. A looser bar admits more, so
the usable-share numbers (90% and 100% on long-throw against 37% and 93%) flatter
both methods there. The dimensionless ratios in the table above carry no bar and
are the ones to read. They were not in the design; they were added when the
confound surfaced, and both are in the results file.

**What survives.** Image-space segmentation is ahead on both archetypes, by every
measure taken, and it is the only one of the two that drives contamination to
zero on both. What does *not* survive is the size of the advantage as a general
claim, and the reason given for it. On a hard archetype the two methods are
nearly equivalent on pose (1.13×), which means the 28× from archetype 1 is a
property of that archetype and not of the method.

**What I would want measured next, and what I would not conclude.** Two
archetypes is not a characterisation. The honest position is that image-space
segmentation is never worse here and is sometimes enormously better, that nobody
knows why the margin varies this much, and that a mechanism nobody can state is a
mechanism that can reverse on the next archetype. Two candidates worth
separating: a longer throw changes how much of each projector's beam reaches the
room at all — long-throw's unsegmented contamination is 10.8% against archetype
1's 16.9%, so there is less of it to remove — and long-throw's much larger
absolute errors may swamp the contamination term rather than being dominated by
it. A third candidate, that long-throw is better constrained by carrying more
cameras, is ruled out: both archetypes use three. This experiment distinguishes
the remaining two not at all.

---

## 5. What to tell someone doing this for real

1. **Segment in the image if you can.** It was never worse than the geometric
   test on either archetype measured, it drives contamination to zero on both,
   and it needs nothing from your calibration. But size the benefit from your own
   rig, not from this page: it was worth 213× on one archetype and 1.1× on the
   other, and nobody here can tell you which yours resembles.
2. **Shoot one all-on frame.** The detector needs the sphere lit all over. One
   extra exposure buys the disc that four crescents cannot.
3. **Frame the ball.** The entire method rests on the room reaching the edge of
   the picture and the sphere not. Crop in and it inverts.
4. **Make the detector report its own uncertainty, and count it.** Ours returns
   the components it rejected and why. Zero warnings across 180 captures is a
   result; a detector that cannot produce that number is one you cannot audit.
5. **Do not discard the geometric test on this evidence.** It recovered 40.1×
   on the harder archetype and left only 0.21% contamination there. On a rig
   like that one the two methods are within 15% of each other, and the geometric
   test needs no extra frame and no framing assumption.
6. **Decide what a refusal means before you need to.** This detector declines
   rather than guessing when the ball is not fully framed, which happened once in
   90 runs. Declining is right, but it silently costs you that camera, and only a
   counter noticed. Whatever you build, make a camera that contributes nothing
   loud rather than merely safe.
7. **Whatever you use, measure the reason and not only the effect.** The causal
   story on this page survived a 30-seed sweep that confirmed the effect and died
   the moment an archetype tested the mechanism.

---

## 6. What this experiment cannot tell you

- **Why the margin varies by a factor of twenty-four between two archetypes.** §4
  lists three candidate explanations and separates none of them. Until one is
  established, the size of image-space segmentation's advantage should be treated
  as unknown for any rig not measured here.
- **Whether it survives anything in front of the ball.** A guard rail, a plinth, a
  visitor. Each breaks the framing assumption in a different way and none is
  modelled — the capture has no occlusion at all. G4's zero is a floor on how
  often the assumption fails, not a bound.
- **Whether the room is the only thing it removes.** Contamination measured as
  zero means the ground-truth ray cast finds no accepted correspondence off the
  sphere. It does not mean the mask is pixel-perfect at the limb, and nothing here
  measures mask precision against a rendered ground-truth silhouette.
- **How it behaves at other room sizes or thresholds.** One room, one threshold.
  Experiment 4 swept those against the geometric test; this swept neither.
- **Anything about the other ten archetypes.** Two of twelve, chosen because they
  bracket the nominal-error axis. Nothing here says how either method behaves with
  two projectors, six cameras, or no floor reference.
- **What `ρ_room` would do.** As in experiment 4, contamination is scaled by an
  ASSUME constant (0.3, unmeasured). But this experiment compares two
  segmentations against the *same* contamination, so `ρ_room` moves both arms
  together — which makes the comparison far less sensitive to it than experiment
  4's absolute numbers were.
