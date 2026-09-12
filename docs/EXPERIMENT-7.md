<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 The Zyra Project -->

# Experiment 7 — what a facet normal costs where the facets are the body

`docs/ARBITRARY-SHAPES.md` reads a tessellated sphere's recovery error as a
Jacobian defect: "a flat facet normal is the derivative of the facet, not of the
surface the facets approximate, so every step carries a Jacobian error that
changes at each facet edge." That reading has been on the record since Phase 5,
has been cited forward, and has never been measured in the one cell that can
isolate it.

**Answer: the position cost is the shift degeneracy again, the rotation cost is
the derivative, and the mechanism on record cannot be the one operating —
because this cell has no curve for a smooth normal to describe, and a smooth
normal helps anyway.**

## The cell, and why it is the only one that separates the two explanations

There are two things a tessellated body can cost a calibration, and the usual
fixture has both:

1. **Model error.** The facets are not the body. A mesh inscribed in a sphere is
   smaller than the sphere everywhere, so a solver fitting it is fitting the
   wrong shape.
2. **Derivative error.** The facet normal is flat where the surface curves, so
   the step direction is built from the derivative of a plane.

The realistic cell — photograph the analytic sphere, fit a mesh inscribed in it
— has both at once, and its numbers cannot say which. The bench's mesh scenario
has only the second. `buildWorld` builds ONE `ellipsoidMesh` and derives both
what the cameras photograph and what the bundle fits from that same object, so
the facets are not an approximation of anything. They are the body.

**Model error is zero by construction there**, which makes the prediction sharp
in both directions. If the facet normal is what costs something, the cost falls
as the facets flatten toward the surface, and swapping the derivative for
`meshNormal: 'smooth'` recovers it where the facets are coarsest. If it is not,
the cost is flat in tessellation and smoothing buys nothing — or costs
something, since in this cell it describes a curve that genuinely is not there.

## The trap this experiment is shaped around

Experiment 6 found the bench mesh scenario's rotation error to be A-12's lens
shift degeneracy and not the mesh at all: hand the solver the true shift and
75% of the error leaves for 0.005% more residual. The same explanation is
available for any gap between the two normals here. Two calibrations far apart
can fit the same photographs, and then the derivative is not fitting better — it
is deciding which of the two the optimiser lands on.

So every mechanism pair is run twice, once with lens shift free and once with it
handed to the solver at truth and pinned there. A gap that survives the
degeneracy being removed is about the derivative. A gap that collapses never
was. Both halves of that diagnostic are needed together: A-18 convicted A-16 of
pinning a parameter at §3.1's nominal of zero, which is wrong by construction,
and measuring whether the wrong value hurts.

## Which comparison is clean, because only one of the two is

The record calls the tessellated sphere against the analytic sphere "the
cleanest comparison in the table, since it changes the representation and
nothing else". It does not. The analytic arm photographs a sphere; a mesh arm
photographs a mesh, and `ellipsoidMesh` puts every vertex on the sphere and
every facet inside it. Measured at triangle centroids against the rig's
0.8636 m radius:

| tessellation | mean deficit | deepest |
| --- | --- | --- |
| 64×128 | 0.349 mm | 0.462 mm |
| 96×192 | 0.155 mm | 0.206 mm |
| 128×256 | 0.087 mm | 0.116 mm |
| 192×384 | 0.039 mm | 0.051 mm |

Falling as the square of the refinement, as a chord should, and small against
the eleven to twenty-two millimetres of pose error being compared — the
midsurface test in `ARBITRARY-SHAPES.md` separately refutes it as a mechanism,
having made the solve worse at 32×64 and done nothing at 64×128. But it is not
"nothing else", so the `vs control` column is the representation AND the body
and isolates neither.

**The mechanism pairs are the clean comparison**: the same mesh, the same
photographs, the same starting rig, with one thing different — which normal the
bundle differentiates the hit against. Every claim this page makes about the
facet normal rests on those.

## The arms

Medians over the seeds where **every** arm converged. That rule is what the arms
table needs and what it costs: the `vs control` columns are ratios taken across
arms, so they need one seed set common to all ten, and a seed any arm failed has
to go from all of them. On thirteen seeds and ten arms it took seven.

The mechanism table below is over a different and larger set, and deliberately —
see the note under it.

<!-- generated: experiment-7-arms -->
| arm | facets | shift | n | median pos | vs control | median rot | vs control | residual | vs control | iters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `analytic` | — | free | 6 | 25.1 mm | 1.00x | **0.0488°** | 1.00x | 0.27431 px | 1.000x | 23 |
| `64x128` | 16,384 | free | 6 | 45.6 mm | 1.82x | **0.0608°** | 1.25x | 0.28401 px | 1.035x | 34 |
| `64x128-smooth` | 16,384 | free | 6 | 29.9 mm | 1.19x | **0.0344°** | 0.71x | 0.28382 px | 1.035x | 27 |
| `96x192` | 36,864 | free | 6 | 27.4 mm | 1.09x | **0.0448°** | 0.92x | 0.27889 px | 1.017x | 36 |
| `128x256` | 65,536 | free | 6 | 24.1 mm | 0.96x | **0.0381°** | 0.78x | 0.27393 px | 0.999x | 43 |
| `192x384` | 147,456 | free | 6 | 36.2 mm | 1.44x | **0.0354°** | 0.73x | 0.27429 px | 1.000x | 39 |
| `192x384-smooth` | 147,456 | free | 6 | 32.5 mm | 1.30x | **0.0440°** | 0.90x | 0.27433 px | 1.000x | 20 |
| `analytic-shift-known` | — | at truth | 6 | 22.2 mm | 1.00x | **0.0312°** | 1.00x | 0.27447 px | 1.000x | 20 |
| `64x128-shift-known` | 16,384 | at truth | 6 | 36.3 mm | 1.64x | **0.0439°** | 1.41x | 0.28360 px | 1.033x | 31 |
| `64x128-smooth-shift-known` | 16,384 | at truth | 6 | 24.9 mm | 1.12x | **0.0294°** | 0.94x | 0.28390 px | 1.034x | 19 |
<!-- /generated -->

## The mechanism pairs

**These are over more seeds than the table above, on purpose.** A pair reads
three arms — the two normals and their control — so requiring the other seven to
have converged would exclude seeds for the behaviour of arms the comparison never
looks at. Restricting the rule to the three arms actually read keeps eleven,
twelve and ten seeds instead of six, and is no weaker for the rows it reports:
every one of them is still a solve the page would install. Every median in this
table is computed over its own pairs and none is carried over from the table
above.

<!-- generated: experiment-7-mechanism -->
| pair | pos: smooth wins | pos excess recovered | rot: smooth wins | rot excess recovered | smooth residual |
| --- | --- | --- | --- | --- | --- |
| coarsest grid, shift free | 9/11, p=0.065 | 106% | **9/11**, p=0.065 | 101% | 1.0023x |
| coarsest grid, shift at truth | 4/12, p=0.39 | -40% | **10/12**, p=0.039 | 141% | 0.9986x |
| finest grid, shift free | 7/10, p=0.34 | 46% | **6/10**, p=0.75 | — (no excess) | 1.0008x |
<!-- /generated -->

## What it says

**1. The position cost at a coarse tessellation is A-12's lens shift
degeneracy, not the derivative.** With shift free, the smooth normal beats the
facet normal on position in 9 of 11 seeds — p=0.065, which on its own is a lean
and not a result. Hand the solver the true shift and pin it, and it becomes
**4 of 12**: whatever the lean was, it does not merely weaken, it goes and
slightly reverses. The facet arm's own median moves 44.3 → 28.8 mm against a
control that moves only 29.8 → 24.0. This is experiment 6's
finding arriving again on a different body: what looked like a cost of being a
mesh was a degenerate direction the two derivatives happened to land in
different places along.

**2. The rotation cost survives the degeneracy being removed, and it tracks
facet coarseness.** At the coarsest grid with shift pinned at truth, smooth wins
rotation **10 of 12** (median 0.0462° → 0.0358°) — the one comparison here that
clears p < 0.05, at 0.039. At the finest grid, with nine times as many facets, it is
**6 of 10** and the facet arm is already better than the analytic control. That
is the direction the design registered before the sweep ran: 64×128 is where a
facet normal is furthest from the surface and any derivative effect is largest,
192×384 is where it should not show, and neither prediction had to be chosen
after the fact.

**3. And it costs nothing in residual.** Across all three pairs the smooth arm's
residual is 0.9986 to 1.0023 of the facet arm's. Both derivatives reach
calibrations that fit the same photographs equally well and point differently.
By A-18's test that is a degenerate direction, not a better fit — the rotation
gain is the two modes choosing different points along a direction the data does
not constrain.

**4. So the mechanism on record cannot be the one operating.** The Phase-5
reading says a smooth Jacobian helps because "the derivative describes the curve
the tessellation is standing in for". In this cell there is no such curve: the
facets are the body the cameras photographed, so the facet normal is the exact
derivative of the real surface and the interpolated normal is the WRONG one —
`packages/solver/test/mesh.test.ts` measures its error against the facet
geometry as the whole facet-to-sphere gap. The wrong derivative produces the
better pointing. What is left of the explanation is not fidelity but
CONTINUITY: an exact derivative that jumps at every facet edge navigates a
weakly determined direction worse than an inexact one that does not jump.

This is a reading, not a proof, and it is offered as the one the measurements
are consistent with rather than the one they compel. What would test it is
measuring WHICH direction carries the error, which nothing here does — the
stiffness test reports one pinned direction (`gauge 1`) on every arm including
the analytic control, so a tessellation frees nothing a sphere does not, and the
direction in question is not one the gauge distinguishes.

**5. The optimiser says the same thing in its stop reasons**, which is the part
that was not designed for and came out anyway. `meshPlateauTol` exists because
the facet Jacobian's jitter stops the ordinary cost tolerance firing twice
running. Over 13 seeds it fires on **11 of 13** coarse facet solves, 10 of 13
with shift pinned, 9 and 10 at the middle grids — and on **none at all** of
either coarse smooth arm, which stop on the ordinary `step` rule 10 and 11 times
out of 13. The smooth arms are also about twice as cheap: 22 against 42 median
iterations at the coarse grid, 15 against 36 with shift pinned, 18 against 43 at
the finest. All six `lambda` stalls in the sweep are in smooth arms and all four
`maxIterations` stops are in facet arms — the same asymmetry the record measured
in the realistic cell, reproduced here.

## What is not claimed

- **That any single test is strong.** Six sign tests were run and one clears
  0.05. Under a correction for six comparisons none would. The evidence is the
  PATTERN and not any one p-value: rotation favours smooth in all three pairs,
  position does not — it flips exactly when the shift degeneracy is closed —
  the rotation effect goes exactly when the facets flatten, and the stop reasons
  agree with both. Thirteen seeds is a small sweep, and the record this corrects
  has more than once had to retract a conclusion drawn from three.
- **Anything about the shipped default.** `meshNormal: 'facet'` was settled on
  540 solves in the realistic cell. This is a different cell, chosen because
  model error is zero in it, and a deployment never has that property. Nothing
  here is an argument for flipping a default.
- **That the facet Jacobian is wrong.** It is exact for what it differentiates,
  and `mesh.test.ts` holds it to central differences. The finding is about what
  an exact but discontinuous derivative does to a search, not about correctness.
- **Which direction carries the error.** Unmeasured; see above.
- **That the position result at the coarse grid is null.** 9 of 11 at p=0.065
  with shift free is not nothing; what the shift-pinned arm shows is that
  whatever it is, it is not the derivative.

## Reproducing

    npm run experiment7

Resumable: each point is appended to
`experiments/experiment-7-tessellation.jsonl` (ignored by git) and skipped if
already there. `--report-only` re-assembles that checkpoint without solving
anything. The tracked artefact is `experiments/experiment-7.json`, which carries
`provisional` and a point count whenever the sweep is short of its design.
