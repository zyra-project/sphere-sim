# Experiment 4 — what the room behind the sphere costs a calibration

**Status: complete. Measured once, not iterated.** Purely geometric — the
measurement is a recovered pose against ground truth and no photometric constant
enters it — so nothing here is PROVISIONAL. The room's own two constants are
class ASSUME and are stated as such throughout.

- **Figure** — [`experiments/experiment-4.svg`](../experiments/experiment-4.svg)
- **Data** — [`experiments/experiment-4.json`](../experiments/experiment-4.json)
- **Reproduce** — `npm run experiment4` (80 solves, about 9 minutes)

---

## The answer

> **Fatal, and no threshold fixes it.** Putting the structured-light pattern on
> the room takes the recovered pose from **20.6 mm to 7841 mm** — a factor of
> 380 — because 14.1% of the accepted correspondences come back from surfaces
> that are not the sphere. Raising the decoder's modulation floor removes the
> far wall but not the floor and the ceiling, which are *nearer* their
> projectors than the ball is and come back at least as bright. The two
> populations do not differ in the quantity the threshold measures. This
> pipeline needs segmentation, not a tuned threshold.

Four things must travel with that sentence.

1. **This is a property of the pipeline, not of a gallery.** The room is a
   cylinder with a flat floor and ceiling and nothing in it. Both of its
   constants are ASSUME and nobody has measured a building. A real room has a
   guard rail, a plinth, a door and a floor that is not the sphere's own plane,
   all nearer than the wall, so this is a floor on the effect rather than a
   bound.
2. **It was off by default before this experiment and it still is.** Every
   number in `bench-results.json` and in Experiments 1–3 was produced with
   `roomSpill: null`, and `capture.test.ts` asserts that condition is
   bit-for-bit the capture that existed before it.
3. **The failure is not graceful.** It is not a degradation curve; it is a coin
   flip. At the shipped threshold with a 6 m room the five seeds ran from 15 mm
   to 40 638 mm. A median is not a summary of that distribution and every raw
   value is in the results file for exactly that reason.
4. **The mitigation axis came out negative.** That is the finding, not a gap in
   it — see §3.

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

**A tenth of the accepted correspondences is enough to destroy the solve.** The
points the room adds are not noise around the right answer. They decode to a
real projector coordinate from a camera ray that never touched the ball, so they
are a consistent, confident lie about where a surface is, and the robust loss
has nothing to reject them on.

**The grid-displacement metric stops existing before the pose error does.** In
the worst cells it comes back NaN, which is the recovered rig being so wrong
that the metric cannot be evaluated on it at all. A pipeline reporting only a
gate pass/fail would show a missing number rather than a bad one.

**The ordering by room size is not established.** The medians are non-monotone —
4 m is nominally better than 6 m — and the falsifier F3 records that. But the
distributions overlap across four orders of magnitude, so with five seeds this
axis cannot be ordered, and the honest reading is that every room in the sweep
is catastrophic rather than that some are worse. What *is* monotone is the
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

**The wall is the bulk of it and the wall is the easy part.** It is 5–10 km²
of surface at nine to eleven metres from its projector, so it comes back dim,
and a modulation floor five times the shipped one removes it completely.

**What is left is the floor and the ceiling, and they are the problem.** They
are two to four metres from the lenses — *nearer than the sphere* — so they
return as much modulation as the ball does. A brightness threshold cannot
separate two populations that are the same brightness. That is a geometric fact
about where a projector hangs in a room, not a tuning problem.

**The 6 m and 9 m rooms give identical rows above 0.02, and that is not a bug.**
Once the wall is rejected the survivors are floor and ceiling, and those are the
same two surfaces in both rooms. `packages/bench/test/capture.test.ts` pins the
geometry that makes it so.

---

## 3. The mitigation that did not work

Sweeping the decoder's absolute modulation floor, `minModulation`, from its
shipped 0.02. Median pose error in millimetres; the seed range in brackets.

| threshold | no room | wall at 6 m |
| --- | ---: | ---: |
| **0.02 (shipped)** | **20.6** [12.9 – 51.5] | **7841** [15.1 – 40 638] |
| 0.10 | 20.6 [12.9 – 51.5] | 49.1 [18.7 – 89 538] |
| 0.20 | 33.2 [12.1 – 47.4] | 515.6 [12.1 – 172 442] |
| 0.40 | 60.8 [46.4 – 63.3] | 62.9 [53.9 – 15 249] |

**Read the brackets, not the medians.** Raising the floor pulls the median back
towards the clean case and leaves the tail exactly where it was: at 0.10 the
median is 49 mm and the worst seed is 89 metres. A threshold that works four
times in five is not a mitigation for a calibration procedure, and reporting the
median alone would have made this table look like a fix.

**It is not free on a clean capture either.** With no room at all, going from
0.02 to 0.40 takes the median from 20.6 mm to 60.8 mm — the floor starts
rejecting genuine sphere pixels at grazing incidence, which are exactly the ones
that constrain the limb.

So F4 is triggered: no floor in the sweep separated them. The conclusion is the
one the falsifier said it would be — **segmentation**. The pipeline has to know
which pixels are the ball before it decodes them, and nothing in this repository
does that.

---

## The falsifiers, and what happened to each

Written into `packages/experiments/src/spill/design.ts` before the sweep ran;
`judge()` evaluates exactly these and the booleans are in the results file.

| # | Falsifier | Outcome |
| --- | --- | --- |
| F1 | The condition is inert — the wall never clears `minModulation` | **Not triggered.** 14.1% of accepted correspondences came from off the sphere |
| F2 | The robust loss absorbs it — the pose does not move | **Not triggered.** The pose moved by a factor of 380 |
| F3 | The cost is not monotone in room size | **Triggered.** The medians are non-monotone; the distributions overlap too far to order the axis at n=5 |
| F4 | No modulation floor separates the two populations | **Triggered.** None did, and §2 says why it cannot |

Two of the four triggered. F4 triggering is the useful result: it converts "tune
the threshold" from a plausible next step into a measured dead end.

---

## What to tell someone doing this for real

1. **Mask the sphere before you decode.** Not after, and not by thresholding
   brightness. The silhouette is a circle in a photograph of a ball and is the
   easiest segmentation problem in the room; skipping it costs three orders of
   magnitude.
2. **Do not tune `minModulation` to fix it.** It removes the far wall, which was
   never the hard part, and leaves the floor and the ceiling, which are as
   bright as the sphere.
3. **Check the tail, not the median, when you evaluate any fix.** Every
   mitigation in this experiment looked like it worked on the median.
4. **A missing grid-displacement number is a worse signal than a large one.** In
   the failing cells the metric could not be evaluated at all.

---

## What this experiment cannot tell you

- **How well segmentation would work**, because nothing here does it. That is
  the obvious next measurement and it needs a component this project has not
  built.
- **What a real gallery costs.** One cylinder, two ASSUME constants, no
  furniture, no second bounce. Light reaches the room and stops.
- **Whether more cameras help.** Experiment 1 found the camera-count knee at
  three on a clean capture; whether contamination changes that is untested, and
  the cells here hold the camera count fixed.
- **Anything about a different archetype.** One archetype, chosen because
  archetype 0 sets ambient to zero and the sensor to null, and a spill
  experiment on a noiseless capture would be measuring one thing while claiming
  another. The cuts in the results file say what that costs.
