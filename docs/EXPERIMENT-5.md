# Experiment 5 — segmenting the sphere in the photograph instead of in the geometry

**Status: complete. Measured once, not iterated.** Purely geometric metric — a
recovered pose against ground truth — so the Phase 2 photometric gate does not
apply to it. See §5 for the one photometric constant in the neighbourhood and
why it matters far less here than it did in experiment 4.

- **Figure** — [`experiments/experiment-5.svg`](../experiments/experiment-5.svg)
- **Data** — [`experiments/experiment-5.json`](../experiments/experiment-5.json)
- **Reproduce** — `npm run experiment5` (270 solves, about 50 minutes, checkpointed per seed)

---

## The answer

> **Image-space segmentation puts the room case back on top of the clean case,
> tail and all.** With a 6 m room present, rejecting camera pixels the photograph
> says are not the sphere takes the recovered pose from a median of **5776 mm to
> 26.3 mm** against a clean baseline of **24.9 mm** — a paired geometric mean of
> **340×** over 30 rig draws, improving **29 of 30**. The geometric test measured
> in experiment 4 is worth **14.7×** on the same draws. Head to head, image-space
> beats it by **23×** and wins on **26 of 30** seeds.
>
> The number that matters most is not a factor. Counting solves no worse than the
> worst clean solve (51.9 mm, set by the data rather than chosen):
>
> | | usable solves |
> | --- | --- |
> | clean capture, no room | 30 / 30 |
> | room, no segmentation | **2 / 30** |
> | room, geometric segmentation | 11 / 30 |
> | room, image-space segmentation | **28 / 30** |
>
> **The tail is gone.** The room's worst seed is 1 226 190 mm and the geometric
> test still leaves a 352 389 mm seed. Image-space segmentation's worst of thirty
> is **54 mm**, against the clean capture's own worst of 52 mm. It does not
> reduce the catastrophic failures; it removes them.

>
> **And the reason given for that advantage is wrong.** The argument was causal:
> the geometric test consults the nominal rig, so it should suffer when the
> nominal is bad. The `long-throw` archetype hands the operator 5.18 m when truth
> is 6.14 m — a nominal 0.96 m out — and there the geometric test gets **better**,
> not worse: paired recovery against the room rises from 14.7× to 33.7×, and the
> contamination it fails to remove falls from 1.185% to 0.207%. Image-space stays
> ahead on both archetypes but its margin collapses from **23.2× to 1.30×**.
> Falsifier G6 triggered. §4 is what that costs the conclusion.

---

## 1. What each arm did

Thirty seeds per arm, archetype 1, `default` preset, shipped decoder threshold.
Every arm is the same thirty rig draws — `seedFor` depends only on the seed
index — so every comparison here is paired. Worst projector position error after
gauge alignment, in millimetres.

| arm | median | min | max | off-sphere share |
| --- | ---: | ---: | ---: | ---: |
| no room, no segmentation | 24.9 | 7.8 | 52 | 0.00% |
| room, no segmentation | 5776 | 15.1 | 1 226 190 | 16.86% |
| room, geometric segmentation (margin 0) | 446.0 | 9.9 | 352 389 | 1.18% |
| **room, image-space segmentation** | **26.3** | 6.8 | **54** | **0.00%** |
| no room, image-space segmentation | 22.6 | 7.0 | 58 | 0.00% |

And the same four conditions on `long-throw`, whose handed-over nominal is 0.96 m
from truth. Note the clean row: this archetype is simply harder, and millimetres
here are not comparable with the table above.

| arm (long-throw) | median | min | max | off-sphere share |
| --- | ---: | ---: | ---: | ---: |
| no room, no segmentation | 92.4 | 25.1 | 618 | 0.00% |
| room, no segmentation | 4111 | 26.1 | 1 332 550 | 10.81% |
| room, geometric segmentation (margin 0) | 97.2 | 32.1 | 1136 | 0.21% |
| room, image-space segmentation | 107.9 | 41.6 | **458** | 0.00% |

**Contamination goes to zero, not merely down.** The geometric test leaves 1.18%
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
against the baseline's 24.9 — a factor of 0.91, inside the seed range and if
anything slightly better, because the pixels it discards at the limb are
grazing-incidence decodes that were never the well-constrained ones.

**Correction — every median on this page was regenerated.** A code review found
that the figure's centre marker took the *upper* of the two middle observations
rather than their mean; the write-up script did the same, and at thirty seeds
that is not the median. The results file always recorded the correct value, so
nothing derived from it moved: the paired geometric means, the usable-share
counts, the ratios in §4 and every falsifier verdict are computed per seed and
are unchanged. The medians themselves moved by up to 6% — the room arm from
6166 mm to 5776, image-space from 26.9 to 26.3, the clean baseline from 25.5 to
24.9 — and the tables above are the corrected ones. Experiment 4 was unaffected
because it ran an odd number of seeds, where the two conventions agree. There is
now one median in the codebase, exported from the spill runner and imported by
both the runner and the plot.

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
| G1 | It does not reduce contamination below the geometric test | **Not triggered.** 0.00% against 1.18% |
| G2 | It does not beat the geometric test on pose, paired | **Not triggered.** Paired geometric mean 23.2 |
| G3 | It costs a clean capture | **Not triggered.** 0.91×, inside the seed range |
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

| | archetype 1 | long-throw |
| --- | ---: | ---: |
| geometric: paired recovery vs the room | 14.7× | **33.7×** |
| image-space: paired recovery vs the room | 340.3× | **43.7×** |
| head to head (image ÷ geometric) | 23.2× | **1.30×** |
| geometric: contamination it fails to remove | 1.185% | **0.207%** |

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
nearly equivalent on pose (1.30×), which means the 23× from archetype 1 is a
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
   rig, not from this page: it was worth 340× on one archetype and 1.3× on the
   other, and nobody here can tell you which yours resembles.
2. **Shoot one all-on frame.** The detector needs the sphere lit all over. One
   extra exposure buys the disc that four crescents cannot.
3. **Frame the ball.** The entire method rests on the room reaching the edge of
   the picture and the sphere not. Crop in and it inverts.
4. **Make the detector report its own uncertainty, and count it.** Ours returns
   the components it rejected and why. Zero warnings across 180 captures is a
   result; a detector that cannot produce that number is one you cannot audit.
5. **Do not discard the geometric test on this evidence.** It recovered 33.7×
   on the harder archetype and left only 0.207% contamination there. On a rig
   like that one the two methods are within 30% of each other, and the geometric
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

- **Why the margin varies by a factor of eighteen between two archetypes.** §4
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
