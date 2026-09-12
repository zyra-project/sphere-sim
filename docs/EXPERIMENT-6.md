<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 The Zyra Project -->

# Experiment 6 — what the ellipsoid's extra rotation is made of

`docs/ARBITRARY-SHAPES.md` reported the `mesh` archetype recovering projector
rotation two to four times worse than `nominal` on the same rig and the same
photons, and recorded it as "inside A-12's shift/pointing degeneracy (0.01 of
shift is 0.172°) ... and **not yet attributed**". Parking a number beside a
plausible mechanism is not attributing it, and the document said so. This
measures it.

**Answer: the degeneracy, and the body is not worse at all — it is better.**

## The trap this experiment is shaped around

The reflex test is to turn `shiftSigma` up and watch the rotation error fall.
That test is worthless here, and A-18 already convicted A-16 of running it:

> Holding a parameter at a known-wrong value measures whether the wrong value
> hurts. It says nothing about whether the parameter is degenerate.

§3.1's nominal lens shift is **zero**, `injectMisalignment` draws the truth from
`N(0, 0.01 · misalignmentScale)`, and `solve` centres its shift prior on the
nominal it is handed — deliberately, because "a prior centred on an estimate
derived from the same data is the fit talking to itself". So a tight
`shiftSigma` alone pins shift at a value that is wrong by construction.

Hence `RunOptions.shiftFromTruth`, which hands the solver a nominal carrying the
TRUE shift. A tight sigma on top of that is A-18's diagnostic; without it, it is
A-16's. Both are run, because the difference between them is itself a result.

## The arms

<!-- generated: experiment-6-arms -->
| arm | sphere rot | **mesh rot** | mesh/sphere | mesh rot removed | mesh residual |
| --- | --- | --- | --- | --- | --- |
| `free` | 0.0460° | **0.0674°** | 1.47x | 0.0% | 0.27736 px |
| `nominal-tight` | 0.0987° | **0.1583°** | 1.60x | -134.7% | 0.27806 px |
| `truth-tight` | 0.0344° | **0.0169°** | 0.49x | 75.0% | 0.27738 px |
| `truth-loose` | 0.0463° | **0.0655°** | 1.41x | 2.8% | 0.27729 px |
| `truth-0.003` | 0.0415° | **0.0404°** | 0.97x | 40.0% | 0.27727 px |
| `truth-0.008` | 0.0461° | **0.0603°** | 1.31x | 10.6% | 0.27724 px |
| `truth-0.021` | 0.0459° | **0.0650°** | 1.42x | 3.7% | 0.27736 px |
| `truth-0.038` | 0.0459° | **0.0657°** | 1.43x | 2.5% | 0.27736 px |
<!-- /generated -->

Median over the seeds where BOTH bodies converged — the document's own three
(1234, 77, 20240001) plus thirty derived from root seed 20260911. Thirty because
five seeds produced a confident decision earlier in this project that thirty
reversed.

Two arm-seeds are excluded on that rule, and the rule is not fastidiousness. The
page refuses a solve that stopped at its iteration cap, so a non-converged
endpoint is a calibration nobody would be allowed to install. An earlier draft of
this page averaged them in and said medians made that safe; they do not. Seed
286650231 failed to converge in `nominal-tight`/`mesh` and its value WAS that
arm's published median — 0.1518 where the converged-only figure is 0.1583. A
median is robust to an outlier's magnitude, not to its sitting in the middle.
Both bodies drop together because the headline is a RATIO, and comparing two
bodies over different seed sets is the thing the paired design exists to
prevent.

## What it says

**1. It is the degeneracy, and the evidence is A-18's own test.** Telling the
solver the true lens shift removes **75.0%** of the mesh's rotation error —
median 0.0674° to 0.0169° — for **0.005%** more residual. The photographs are
fit just as well by a calibration whose pointing is four times better, which is
the definition of a degeneracy and not a solver defect. A-12 is confirmed as the
mechanism, on the body the question was asked about.

**2. The body is not worse. It is better, and the degeneracy was hiding that.**
With shift known, the ellipsoid recovers rotation at **0.49x** the sphere's
error — 0.0169° against 0.0344°, roughly twice as well. That is the same thing
ARBITRARY-SHAPES already observed about camera rotation ("better on every seed,
which is what a body with no symmetry axis should do for the apparatus looking
at it"), and the projector rotation turns out to agree once the degeneracy
common to both bodies stops dominating. The ellipsoid was not paying for being a
mesh; it was losing more of an advantage it actually had.

**3. "Two to four times worse" is a small-sample artifact.** The three
documented seeds give a mesh/sphere ratio of **3.08x**. The full set gives
**1.47x**. The documented three are a bad draw, and the sweep reproduces them
exactly — 0.0376 / 0.0353 / 0.0511 against 0.1711 / 0.0416 / 0.1157 — which is
what makes the wider number trustworthy rather than merely different.

**4. A-16's test would have given the opposite answer, and not by a little.**
Pinning shift at §3.1's nominal zero makes rotation **worse on both bodies**:
mesh 0.0674° to 0.1583°, sphere 0.0460° to 0.0987°. Anyone running the reflex
test would have concluded that shift is not the mechanism — precisely A-16's
error, reproduced here on data A-18 never saw. The control earns its place.

**5. A-12's remedy, as its own arithmetic sizes it, buys almost nothing.** The
`truth-loose` arm centres the prior on TRUTH at sigma 0.058 — A-12's own width,
the shift worth one degree of pointing against §2's 1-2° mount tolerance — and
removes **2.8%**. Even centred on the true value, a prior that wide does
essentially nothing. The benefit is in the WIDTH, not the centring: reading the
shift off the projector's menu helps only if it is read precisely.

That last point is new and it is a message for the spec. A-12 proposes "a
plausible range in §3.1, in the same spirit as §2's ±1-2° mount tolerance". This
says such a range would be too loose to reach the §7 rotation gate. What the
gate needs is a shift known to nearer 0.001 than to 0.058, and where between
those the knee sits is **not measured here** — two points do not locate a knee.

## Round 2: where the knee is

Round 1 measured the two ends and said plainly that two points do not locate a
knee. Four intermediate widths, same 33 seeds, same converged-pair rule:

| sigma | as yaw (A-12: 0.01 = 0.172°) | mesh rotation | removed | mesh/sphere |
| --- | --- | --- | --- | --- |
| free | — | 0.0674° | — | 1.47x |
| 0.058 | 1.00° | 0.0655° | 2.8% | 1.41x |
| 0.038 | 0.65° | 0.0657° | 2.5% | 1.43x |
| 0.021 | 0.36° | 0.0650° | 3.7% | 1.42x |
| **0.008** | **0.14°** | 0.0603° | **10.6%** | 1.31x |
| **0.003** | **0.05°** | 0.0404° | **40.0%** | 0.97x |
| 0.001 | 0.02° | 0.0169° | 75.0% | 0.49x |

**The knee is between 0.021 and 0.008, and the benefit runs steeply below it.**
From 0.058 down to 0.021 nothing happens — 2.5% to 3.7%, a spread no wider than
the scatter, so three widths spanning a factor of three are indistinguishable
from no prior at all. It moves at 0.008, and then climbs hard: 40% at 0.003 and
75% at 0.001.

**The width that starts to work is the width of the gate.** Converted through
A-12's own arithmetic, 0.003 is 0.052° of yaw and §7's rotation gate is 0.05°.
The benefit appears when the shift is pinned to about the tolerance being asked
for, which is not a coincidence so much as a statement of what a prior can do: a
prior looser than the tolerance cannot enforce it, whatever it is centred on.

**And the body's advantage is bought at the same price.** The mesh/sphere ratio
crosses 1.0 between 0.003 and 0.001. The ellipsoid recovering rotation BETTER
than the sphere — round 1's most surprising result — is not a property of the
body on its own; it appears only once shift is known to better than about
0.003, and is invisible at every looser width.

**For A-12, in the units the amendment is written in.** §2's stated ±1-2° mount
tolerance corresponds to a shift of roughly 0.058 to 0.116. That is the flat
part of this table. A range for `shift_h`/`shift_v` "in the same spirit" would
sit entirely inside the region where the prior buys 3%, and §8 item 2's reading
off the projector's menu has to be good to about **0.003 of the half-image —
three pixels of principal point on a 1920 raster** — before it is worth writing
down at all.

## What is not claimed

- **That 0.001 is the floor.** The curve is still climbing there: 75% is the
  last point measured, not a plateau. What a tighter prior would buy, and
  whether it ever reaches the gate, is unmeasured.
- **That the sigmas between 0.008 and 0.003 are resolved.** The knee is bracketed,
  not located to a figure. Four widths across two orders place it; they do not
  pin it.
- **That this closes A-12.** It confirms A-12's mechanism and prices A-12's
  remedy; it does not decide what §3.1 should say, which is the author's.
- **Anything about the other bodies.** One ellipsoid, at one tessellation.
- **That the sphere is unaffected.** It is not: truth-tight removes 25.1% of the
  sphere's rotation error too, for -0.085% residual. The degeneracy is common to
  both bodies. What differs is how much each was losing to it.

Non-convergence was one seed in `free` (sphere) and one in `nominal-tight`
(mesh), out of 264 solves. Both seeds are excluded from both bodies of their
arm, per the rule above.

## Reproducing

    npm run experiment6

Resumable: each point is appended to `experiments/experiment-6-meshrot.jsonl`
(ignored by git) and skipped if already there. The tracked artefact is
`experiments/experiment-6.json`, which carries `provisional` and a point count
whenever the sweep is short of its design.
