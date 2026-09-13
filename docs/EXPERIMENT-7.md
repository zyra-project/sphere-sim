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
| `analytic` | — | free | 8 | 35.3 mm | 1.00x | **0.0488°** | 1.00x | 0.27522 px | 1.000x | 25 |
| `64x128` | 16,128 | free | 8 | 43.5 mm | 1.23x | **0.0836°** | 1.71x | 0.28784 px | 1.046x | 44 |
| `64x128-smooth` | 16,128 | free | 8 | 37.5 mm | 1.06x | **0.0583°** | 1.20x | 0.28804 px | 1.047x | 34 |
| `96x192` | 36,480 | free | 8 | 49.7 mm | 1.41x | **0.0552°** | 1.13x | 0.28037 px | 1.019x | 39 |
| `128x256` | 65,024 | free | 8 | 40.6 mm | 1.15x | **0.0659°** | 1.35x | 0.27674 px | 1.006x | 38 |
| `192x384` | 146,688 | free | 8 | 33.8 mm | 0.96x | **0.0364°** | 0.75x | 0.27429 px | 0.997x | 36 |
| `192x384-smooth` | 146,688 | free | 8 | 35.0 mm | 0.99x | **0.0440°** | 0.90x | 0.27433 px | 0.997x | 22 |
| `analytic-shift-known` | — | at truth | 8 | 31.2 mm | 1.00x | **0.0322°** | 1.00x | 0.27538 px | 1.000x | 21 |
| `64x128-shift-known` | 16,128 | at truth | 8 | 40.4 mm | 1.29x | **0.0481°** | 1.50x | 0.28765 px | 1.045x | 41 |
| `64x128-poleX-shift-known` | 16,128 | at truth | 8 | 48.2 mm | 1.54x | **0.0859°** | 2.67x | 0.28753 px | 1.044x | 36 |
| `64x128-poleX-smooth-shift-known` | 16,128 | at truth | 8 | 33.3 mm | 1.07x | **0.0593°** | 1.84x | 0.28654 px | 1.041x | 21 |
| `64x128-smooth-shift-known` | 16,128 | at truth | 8 | 38.0 mm | 1.22x | **0.0376°** | 1.17x | 0.28695 px | 1.042x | 25 |
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
| coarsest grid, shift free | 21/26, p=0.0025 | 70% | **22/26**, p=0.00053 | 64% | 0.9939x |
| coarsest grid, shift at truth | 13/25, p=1.0 | 69% | **21/25**, p=0.00091 | 107% | 1.0000x |
| finest grid, shift free | 15/24, p=0.31 | 57% | **11/24**, p=0.84 | — (no excess) | 1.0001x |
| coarsest grid, shift at truth, POLES ON X | 21/25, p=0.00091 | 104% | **20/25**, p=0.0041 | 63% | 0.9967x |
<!-- /generated -->

## What it says

Thirty paired seeds plus the documented one, 310 solves. The twelve-seed pass
said the same three things more weakly; every one of them survives, and the
axis table below is new.

**1. The position cost at a coarse tessellation is A-12's lens shift
degeneracy, not the derivative.** With shift free the smooth normal beats the
facet normal on position in **21 of 26** seeds (p=0.0025). Hand the solver the
true shift and pin it and that becomes **13 of 25** (p=1.0) — not weakened,
gone. The twelve-seed pass saw 9/11 → 4/12 and called it a lean; thirty seeds
make it a result, in the same direction.

**2. The rotation cost survives the degeneracy and tracks facet coarseness.**
At the coarsest grid with shift pinned at truth, smooth wins rotation **21 of
25** (p=0.00091), median 0.0524° → 0.0385°. At the finest grid, with nine times
as many facets, it is **11 of 24** (p=0.84) and the facet arm is already better
than the analytic control. Both directions were registered in the design before
either sweep ran: 64×128 as the rung where a facet normal is furthest from the
surface, 192×384 as the rung where it should not show.

**3. It is YAW, and that is the answer to the question the record left open.**
`ARBITRARY-SHAPES.md` says, in the same paragraph as the reading this
experiment tests, "which directions carry the error has not been measured; this
is the reading, not the proof." It is measured now. With the degeneracy closed,
yaw goes 0.0410° → 0.0167° on **21 of 25** seeds (p=0.00091) while pitch does
nothing (12/25) and roll does nothing (9/25). At the finest grid yaw stops
moving too (14/24, p=0.54), exactly as the coarseness story requires.

**4. Smoothing costs a little roll**, and this is the one thing neither sweep
was looking for. Roll goes the wrong way in all three pairs — 8/26, 9/25, 7/24 —
each individually weak (p=0.076, 0.23, 0.064) and all three in the same
direction. Too consistent to omit and too weak to call established; recorded as
a trade to watch rather than a finding.

**5. With the degeneracy closed it costs no residual.** In the shift-pinned
pair the smooth arm's residual is **1.0000×** the facet arm's: the same fit,
reached at a different pointing, which is A-18's degenerate direction rather
than a better fit. With shift free the fits do differ slightly (0.9939×), so
that pair is not a clean degeneracy argument — which is the second reason the
shift-pinned pair is the one the claim rests on.

**6. The optimiser says the same thing in its stop reasons**, unbidden.
`meshPlateauTol` — the rule that exists because the facet Jacobian's jitter
stops the ordinary cost tolerance firing twice running — fires on **26 of 31**
coarse facet solves and 20 of 31 with shift pinned, against **2 and 0** on the
corresponding smooth arms, which stop on the ordinary `step` rule 22 and 23
times. Smooth is also about half the work: 25 median iterations against 44, and
25 against 45 with shift pinned. Every `lambda` stall in the sweep (15) is in a
smooth arm; every `maxIterations` stop (14) is in a facet arm.

So what survives of the reading is not fidelity but **continuity**: an exact
derivative that jumps at every facet edge steers a weakly determined direction —
yaw — worse than an inexact one that does not jump. Offered as a reading. What
would test it further is why yaw and not pitch, which nothing here measures.

## What is not claimed

- **That the arms table is strong.** It is n=12, because a seed counts there
  only if all ten arms converged and 19 of 31 lost at least one. The mechanism
  pairs are n=24–26 because a pair pays for its own three arms; that difference
  is the whole reason the policy is split, and the claims live on the pairs.
- **That roll is established.** Three weak results in one direction is a reason
  to look, not a conclusion.
- **Anything about the shipped default.** `meshNormal: 'facet'` was settled on
  540 solves in the realistic cell, which is the cell a deployment is in. This
  one was chosen because model error is zero in it, which no deployment has.
- **That the facet Jacobian is wrong.** It is exact for what it differentiates
  and `mesh.test.ts` holds it to central differences. The finding is about what
  an exact but discontinuous derivative does to a search.
- **Why yaw.** Still unexplained, though one candidate is now ruled out — see
  the section after next. The stiffness test reports one pinned direction
  (`gauge 1`) on every arm including the analytic control, so a tessellation
  frees nothing a sphere does not, and the gauge does not distinguish the axis
  that moves.

## Which axis the derivative moves

<!-- generated: experiment-7-axes -->
| pair | axis | facet | smooth | smooth wins | sign test |
| --- | --- | --- | --- | --- | --- |
| coarsest grid, shift free | `yaw` | 0.0902° | **0.0389°** | 22/26 | 0.00053 |
|  | `pitch` | 0.0651° | **0.0477°** | 21/26 | 0.0025 |
|  | `roll` | 0.0227° | 0.0300° | 8/26 | 0.076 |
| coarsest grid, shift at truth | `yaw` | 0.0410° | **0.0167°** | 21/25 | 0.00091 |
|  | `pitch` | 0.0259° | 0.0321° | 12/25 | 1.0 |
|  | `roll` | 0.0204° | 0.0283° | 9/25 | 0.23 |
| finest grid, shift free | `yaw` | 0.0218° | **0.0199°** | 14/24 | 0.54 |
|  | `pitch` | 0.0305° | 0.0367° | 9/24 | 0.31 |
|  | `roll` | 0.0196° | 0.0225° | 7/24 | 0.064 |
| coarsest grid, shift at truth, POLES ON X | `yaw` | 0.0590° | **0.0228°** | 23/25 | 0.000019 |
|  | `pitch` | 0.0450° | **0.0406°** | 10/25 | 0.42 |
|  | `roll` | 0.0256° | 0.0357° | 11/25 | 0.69 |
<!-- /generated -->

## The tessellation's poles are NOT why it is yaw

Yaw is rotation about Z (`rotZ(pose.yawDeg)`) and `ellipsoidMesh` puts its UV
poles on Z — where the facets are least like the surface, the bands emit one
triangle per cell instead of two, and the vertex fans collapse to a duplicated
point. The axis carrying the error was the axis the tessellation's singularities
sat on. Either a mechanism or a coincidence, and turning the tessellation tells
which.

`EllipsoidSpec.poleAxis` puts the poles on X instead. On a sphere the body does
not move — a sphere is the same sphere however its parametrisation is oriented,
and `ellipsoidMesh` refuses the option on anything that is not one — so only the
facet layout changes. The prediction was registered in `design.ts` before the
arms ran: if the poles carry it, yaw stops being the axis smoothing rescues; if
the rig or the gauge carries it, yaw stays wherever the poles are.

**It stays.** Paired, shift pinned at truth, worst projector per axis:

| poles | yaw, facet → smooth | yaw wins | pitch wins | roll wins |
| --- | --- | --- | --- | --- |
| on Z | 0.0410° → 0.0167° | 21/25, p=0.00091 | 12/25 | 9/25 |
| on X | 0.0590° → 0.0228° | 23/25, p=1.9e-05 | 10/25 | 11/25 |

Same axis, same profile, if anything a stronger effect. **The coincidence was a
coincidence**, and whatever selects yaw is upstream of the mesh's
parametrisation entirely.

ONE THING DID FOLLOW THE TESSELLATION, which is why this is a negative result
and not a null one: turning the grid made the facet solve WORSE — yaw 0.0410° to
0.0590°, total rotation 0.0524° to 0.0873°. The orientation of the tessellation
sets the MAGNITUDE of the error without touching the AXIS that carries it, and
nothing predicted those would separate.

Recorded because a refutation nobody writes down gets proposed again. The
hypothesis was formed in five minutes from two lines of code, said so before it
was run, and was wrong.

## Reproducing

    npm run experiment7

Resumable: each point is appended to
`experiments/experiment-7-tessellation.jsonl` (ignored by git) and skipped if
already there. `--report-only` re-assembles that checkpoint without solving
anything. The tracked artefact is `experiments/experiment-7.json`, which carries
`provisional` and a point count whenever the sweep is short of its design.
