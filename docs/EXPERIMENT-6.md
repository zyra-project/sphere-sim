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
| `free` | 0.0463° | **0.0684°** | 1.48x | 0.0% | 0.27729 px |
| `nominal-tight` | 0.1017° | **0.1518°** | 1.49x | -121.8% | 0.27816 px |
| `truth-tight` | 0.0344° | **0.0169°** | 0.49x | 75.3% | 0.27738 px |
| `truth-loose` | 0.0463° | **0.0655°** | 1.41x | 4.3% | 0.27729 px |
<!-- /generated -->

Median over 33 seeds — the document's own three (1234, 77, 20240001) plus thirty
derived from root seed 20260911. Thirty because five seeds produced a confident
decision earlier in this project that thirty reversed.

## What it says

**1. It is the degeneracy, and the evidence is A-18's own test.** Telling the
solver the true lens shift removes **75.3%** of the mesh's rotation error —
median 0.0684° to 0.0169° — for **0.032%** more residual. The photographs are
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
documented seeds give a mesh/sphere ratio of **3.08x**. Thirty-three seeds give
**1.48x**. The documented three are a bad draw, and the sweep reproduces them
exactly — 0.0376 / 0.0353 / 0.0511 against 0.1711 / 0.0416 / 0.1157 — which is
what makes the wider number trustworthy rather than merely different.

**4. A-16's test would have given the opposite answer, and not by a little.**
Pinning shift at §3.1's nominal zero makes rotation **worse on both bodies**:
mesh 0.0684° to 0.1518°, sphere 0.0463° to 0.1017°. Anyone running the reflex
test would have concluded that shift is not the mechanism — precisely A-16's
error, reproduced here on data A-18 never saw. The control earns its place.

**5. A-12's remedy, as its own arithmetic sizes it, buys almost nothing.** The
`truth-loose` arm centres the prior on TRUTH at sigma 0.058 — A-12's own width,
the shift worth one degree of pointing against §2's 1-2° mount tolerance — and
removes **4.3%**. Even centred on the true value, a prior that wide does
essentially nothing. The benefit is in the WIDTH, not the centring: reading the
shift off the projector's menu helps only if it is read precisely.

That last point is new and it is a message for the spec. A-12 proposes "a
plausible range in §3.1, in the same spirit as §2's ±1-2° mount tolerance". This
says such a range would be too loose to reach the §7 rotation gate. What the
gate needs is a shift known to nearer 0.001 than to 0.058, and where between
those the knee sits is **not measured here** — two points do not locate it.

## What is not claimed

- **Where the knee is.** Two sigmas were run, three orders apart. The sweep that
  finds the usable precision is a sigma ladder and has not been run.
- **That this closes A-12.** It confirms A-12's mechanism and prices A-12's
  remedy; it does not decide what §3.1 should say, which is the author's.
- **Anything about the other bodies.** One ellipsoid, at one tessellation.
- **That the sphere is unaffected.** It is not: truth-tight removes 25.7% of the
  sphere's rotation error too, for -0.055% residual. The degeneracy is common to
  both bodies. What differs is how much each was losing to it.

Non-convergence was one seed in `free` (sphere) and one in `nominal-tight`
(mesh), out of 264 solves; medians are reported for that reason.

## Reproducing

    npm run experiment6

Resumable: each point is appended to `experiments/experiment-6-meshrot.jsonl`
(ignored by git) and skipped if already there. The tracked artefact is
`experiments/experiment-6.json`, which carries `provisional` and a point count
whenever the sweep is short of its design.
