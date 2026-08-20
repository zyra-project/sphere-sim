# Experiment 5 — segmenting the sphere in the photograph instead of in the geometry

**Status: complete. Measured once, not iterated.** Purely geometric metric — a
recovered pose against ground truth — so the Phase 2 photometric gate does not
apply to it. See §5 for the one photometric constant in the neighbourhood and
why it matters far less here than it did in experiment 4.

- **Data** — [`experiments/experiment-5.json`](../experiments/experiment-5.json)
- **Reproduce** — `npm run experiment5` (150 solves, about 17 minutes, checkpointed per arm)

---

## The answer

> **Image-space segmentation puts the room case back on top of the clean case,
> tail and all.** With a 6 m room present, rejecting camera pixels the photograph
> says are not the sphere takes the recovered pose from a median of **6166 mm to
> 26.9 mm** against a clean baseline of **25.5 mm** — a paired geometric mean of
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

---

## 1. What each arm did

Thirty seeds per arm, archetype 1, `default` preset, shipped decoder threshold.
Every arm is the same thirty rig draws — `seedFor` depends only on the seed
index — so every comparison here is paired. Worst projector position error after
gauge alignment, in millimetres.

| arm | median | min | max | off-sphere share |
| --- | ---: | ---: | ---: | ---: |
| no room, no segmentation | 25.5 | 7.8 | 52 | 0.00% |
| room, no segmentation | 6166 | 15.1 | 1 226 190 | 16.88% |
| room, geometric segmentation (margin 0) | 451.9 | 9.9 | 352 389 | 1.21% |
| **room, image-space segmentation** | **26.9** | 6.8 | **54** | **0.00%** |
| no room, image-space segmentation | 22.7 | 7.0 | 58 | 0.00% |

**Contamination goes to zero, not merely down.** The geometric test leaves 1.21%
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

**It is free on a clean capture.** With no room at all it lands at 22.7 mm
against the baseline's 25.5 — a factor of 0.91, inside the seed range and if
anything slightly better, because the pixels it discards at the limb are
grazing-incidence decodes that were never the well-constrained ones.

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
falsifier G4. **Across all 60 image-space runs, in 180 camera captures, the count
is zero.** A silhouette detector that silently returns the floor would be worse
than none, because the floor it hands the solver is a self-consistent lie of
exactly the kind experiment 4 measured.

---

## 3. The falsifiers, and an uncomfortable fact about them

| # | Falsifier | Outcome |
| --- | --- | --- |
| G1 | It does not reduce contamination below the geometric test | **Not triggered.** 0.00% against 1.21% |
| G2 | It does not beat the geometric test on pose, paired | **Not triggered.** Paired geometric mean 23.2 |
| G3 | It costs a clean capture | **Not triggered.** 0.91×, inside the seed range |
| G4 | Its framing assumption fails somewhere | **Not triggered.** 0 failures in 180 camera captures |
| G5 | The win is not consistently signed | **Not triggered.** 26 of 30 seeds |

**Nothing triggered, and that is the weakest position a falsification design can
be in.** When every pre-registered test passes, the result is either a good
method or a weak set of tests, and the page cannot tell you which from the inside.
So, in fairness to the reader: G4 is the one with teeth — it counts a mechanical
property of each capture and would have fired on a single ambiguous frame out of
180. G5 needed a majority of thirty paired draws and would have caught an effect
carried by a few lucky rigs; the geometric arm, on the same test, wins only 19 of
30. G3 is checked against the clean baseline's own worst seed rather than a number
chosen afterwards.

**One cut belongs here rather than in the appendix.** Seed 0 was run before these
five were written — wiring a new detector into the bench needs one end-to-end run
to know it works at all, and that run produced numbers (9.6 mm at 0.00%
contamination). The falsifiers were written knowing that. They are phrased so a
single favourable draw cannot satisfy any of them, but they are not blind, and the
honest reading is that they were pre-registered against the other 29 seeds.

---

## 4. What to tell someone doing this for real

1. **Segment in the image, not against your nominal rig.** It is worth 340× where
   the geometric test is worth 15×, and unlike the geometric test it does not
   depend on the calibration you are trying to measure.
2. **Shoot one all-on frame.** The detector needs the sphere lit all over. One
   extra exposure buys the disc that four crescents cannot.
3. **Frame the ball.** The entire method rests on the room reaching the edge of
   the picture and the sphere not. Crop in and it inverts.
4. **Make the detector report its own uncertainty, and count it.** Ours returns
   the components it rejected and why. Zero warnings across 180 captures is a
   result; a detector that cannot produce that number is one you cannot audit.
5. **You may still want the geometric test, but second.** They compose: nothing
   here measures the two together at 30 seeds, and the one-seed probe that did
   was no better than image-space alone.

---

## 5. What this experiment cannot tell you

- **Whether it survives a badly wrong nominal — and note this is the interesting
  half.** Every cell uses archetype 1, whose documented calibration is close.
  `long-throw`, where the documented distance is nearly a metre out, is where the
  GEOMETRIC test should be expected to collapse and where this one should not care
  at all, because it never reads the rig. That asymmetry is the obvious next
  measurement and this experiment does not make it.
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
- **What `ρ_room` would do.** As in experiment 4, contamination is scaled by an
  ASSUME constant (0.3, unmeasured). But this experiment compares two
  segmentations against the *same* contamination, so `ρ_room` moves both arms
  together — which makes the comparison far less sensitive to it than experiment
  4's absolute numbers were.
