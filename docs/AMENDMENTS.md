# Proposed amendments to PARAMETERS.md and conventions.ts

PARAMETERS.md is authoritative. Nothing in this file has been applied to it, and
no constant has been silently changed anywhere in the code. Each entry records a
place where implementing the spec exposed an ambiguity, an internal tension, or
new evidence — with the reasoning, so the author can accept, reject, or refine it.

Status values: `OPEN` (awaiting a decision), `ACCEPTED` (author approved; the
edit still needs making in PARAMETERS.md), `REJECTED` (author declined; the code
keeps following the current spec text), `APPLIED` (see below — our own documents
only).

## Two different targets, two different rules

Entries here address one of two documents, and the rule differs:

- **`docs/PARAMETERS.md` — the spec. Never edited by us.** It is authoritative,
  its conflicts are deliberate, and it wins over anything found online. Entries
  targeting it stay `OPEN` until the author decides. Nothing is applied, and no
  constant is silently changed anywhere in the code.
- **`packages/calibration/src/conventions.ts` — our own contract.** We wrote it,
  so a self-contradiction in it is our bug to fix, and leaving it broken would
  mean the two models are implementing an ambiguous target. Entries targeting it
  can go to `APPLIED`, with the change recorded here and a revision note left in
  the file. Fixing prose in the contract is not the same as sharing code across
  the boundary: both sides still implement it independently.

| Entry | Target | Status |
| --- | --- | --- |
| A-01 | PARAMETERS.md §3.1 / §4.3 / §7 | OPEN |
| A-02 | PARAMETERS.md §4.4 / §4.5 | OPEN |
| A-03 | PARAMETERS.md §7 | OPEN |
| A-04 | PARAMETERS.md §1 | OPEN |
| A-05 | PARAMETERS.md §4.3 | OPEN |
| A-06 | PARAMETERS.md §2 | OPEN |
| A-07 | conventions.ts §R | **APPLIED** |
| A-08 | conventions.ts (new §C) | **APPLIED** |
| A-09 | PARAMETERS.md §7 | OPEN |
| A-10 | PARAMETERS.md §7 / §2 | OPEN |
| A-11 | PARAMETERS.md §7 / §8 | OPEN |
| A-12 | PARAMETERS.md §3.1 / §7 / §8 | OPEN |
| A-13 | PARAMETERS.md §3.1 / §8 | OPEN |

---

## A-01 — §3.1 / §4.3 / §7: which raster dimension does the sphere diameter match?

**Status:** OPEN. Blocking for the off-sphere-flux gate; worked around in code.

**The tension.** Three clauses cannot all hold at once for a 16:9 projector.

1. §3.1 gives `T ≈ 3.0:1`, derived as "image **width** ≈ sphere diameter at
   `d_proj`", and `fov_h ≈ 18.9°`. That checks out: `2·atan(1/(2·3.0))` = 18.92°.
2. §4.3 requires coverage to reach latitude 80.4° along a projector's meridian,
   producing the four-lobed scalloped unlit polar region.
3. §7 puts the off-sphere flux floor at "~51% from raster geometry".

The sphere's angular diameter from a lens at 5.18 m is `2·asin(R/d)` = **19.2°**.
So an 18.9° horizontal FOV barely fails to contain the silhouette horizontally,
and the **vertical** FOV of a 16:9 raster is only
`2·atan(tan(9.46°)·1080/1920)` = **10.7°** — a little over half the silhouette.
A projector so configured cannot illuminate anything above about latitude 33°,
let alone 80.4°. Clause 1 as literally written contradicts clause 2.

**On clause 3.** If content is masked to the silhouette (which is what the Red
Ball procedure produces) and the silhouette circle is inscribed in the raster's
**minor** dimension, the off-sphere fraction is `1 − (π/4)·(h/w)`:

| Raster | Off-sphere floor |
| --- | --- |
| 16:10 (1920×1200) | **50.9%** |
| 16:9 (1920×1080) | 55.8% |
| 4:3 | 41.1% |

The stated ~51% floor matches **16:10 almost exactly** and does not match 16:9.
That is independent evidence that the intended construction inscribes the sphere
in the raster's minor axis, and a hint that the projector behind the figure was
16:10.

**Proposed amendment.** State explicitly in §3.1 that the sphere's silhouette is
inscribed in the raster's **minor** dimension, and give the throw ratio in those
terms. For a 16:9 raster that is `T ≈ 1.69:1` in the conventional
distance-over-width sense, with the horizontal image over-throwing the sphere by
16:9. Then either (a) note that the §7 floor of ~51% presumes a 16:10 raster and
becomes 55.8% at 16:9, or (b) restate the gate relative to the analytic floor.

**What the code does meanwhile.** `sim` computes the frustum so the silhouette is
inscribed in the minor axis (satisfying §4.3, which is the clause with a
correctness check attached), computes the analytic off-sphere floor from the
configured aspect ratio, and reports off-sphere flux **both** as an absolute
fraction against the documented 52% gate **and** as excess-above-analytic-floor.
Scoring uses the excess form, so the gate measures misaim rather than the
projector's aspect ratio. Both numbers appear in `bench-results.json`.

---

## A-02 — §4.5 / §4.4: `bottommask` units are inferred, and the inference is load-bearing

**Status:** OPEN. Flagged in the spec itself; restated here because a metric depends on it.

§4.4 reads `set bottommask 60,70` as onset and full-mask **latitude**, and marks
the reading `ASSUME — verify`. §7 then makes "unlit fraction within the mask
boundary" a **hard** 0% requirement computed inside `mask_lo`.

So an inferred unit governs the domain of the only gate with no tolerance. If
the values are instead degrees of **colatitude** (i.e. 60° from the south pole =
latitude −30°), the protected region roughly triples and the hard gate applies
over a much larger area at much worse incidence.

The latitude reading is well supported — §4.4's observation that 60° matches the
computed seam-direction usable limit of ≈59° is a strong coincidence — but the
consequence of being wrong is a gate that silently tests the wrong region.

**Proposed amendment.** Keep the latitude reading, and add one line to the
ground-truth checklist (§8 item 15) making it an explicit read: photograph the
polar region with a latitude-labelled test pattern so the boundary can be read
off directly rather than inferred.

**What the code does meanwhile.** `mask_lo`/`mask_hi` are configurable, the
colatitude reading is available as a scenario flag, and the bench reports the
unlit-fraction gate under both interpretations so the difference is visible.

---

## A-03 — §7: the off-sphere flux gate has no stated aspect-ratio dependence

**Status:** OPEN. Subsumed by A-01; recorded separately because it is a gate.

The gate is `≤ 52%` against a floor of `~51%`, i.e. a **1 percentage point**
budget for misaim. That is a tight, well-chosen gate *if* the floor is right for
the configured hardware, and vacuous or unpassable if it is not — at 16:9 the
floor alone is 55.8% and the gate can never pass regardless of alignment quality.

**Proposed amendment.** Restate as "off-sphere flux ≤ analytic raster floor +
1.0 percentage point", which preserves the intent (catch gross misaim) and is
invariant to the projector's aspect ratio.

---

## A-04 — §1: `ρ_R,G,B` has no stated plausible range, but the sensitivity sweep needs one

**Status:** OPEN. Low risk; recorded for completeness.

§10 ranks `ρ_R,G,B` fourth of the four highest photometric risks and calls its
range "narrower" than the others, but no numeric range appears. Experiment 3
sweeps every ASSUME constant across its stated plausible range, so this one had
to be invented: the code uses 0.80–0.95 (0.78–0.95 for blue) and marks the range
`rangeSource: 'inferred'` in `packages/calibration/src/parameters.ts`.

Every sensitivity result for `ρ` is therefore conditional on a range we made up.
The experiment output labels these rows distinctly from rows whose range the spec
states, because a sensitivity ranking that mixes the two is misleading.

**Proposed amendment.** State a range for `ρ_R,G,B` in §1, or add a line to §8
capturing it from a white-field frame against a reference card.

The same applies, with the same treatment in code, to: `α_spec`, `g_R,G,B`,
`wp_i`, `E_amb_chroma`, `ρ_room`, `w_width`, `mask_lo`, `mask_hi`, `h_eye`, and
`fov_eye`.

---

## A-05 — §4.3: the stated unlit polar area is not reachable from §4.3's own boundary latitudes

**Status:** OPEN. Not blocking; no gate depends on it. Reported by the forward model.

**The tension.** §4.3 makes three quantitative claims in one paragraph:

1. Coverage reaches latitude **80.4°** along a projector's own meridian.
2. Coverage reaches only **76.3°** in the seam directions, so the unlit region is
   four-lobed and scalloped rather than a circular cap.
3. The unlit region is "roughly **1.4–2.8%** of the sphere by area, per pole".

Claims 1 and 2 are reproduced exactly by `packages/sim` — to four decimal places,
from the general vector limb test rather than from the closed form, and asserted
in `coverage.test.ts`. But those two latitudes **bound** the area, and the bound
excludes the stated range.

The unlit region is contained in the circular cap above the seam-direction limit
and contains the circular cap above the meridian limit. A cap above latitude `L`
is `(1 − sin L)/2` of the sphere, so at d = 5.18 m:

| Bound | Latitude | Area fraction |
| --- | --- | --- |
| Cap above the meridian limit (strict lower bound) | 80.403° | **0.700%** |
| **The actual scalloped region** | — | **0.893%** |
| Cap above the seam limit (strict upper bound) | 76.363° | **1.410%** |

Integrating `(1 − sin λ_b(ψ))` over longitude gives **0.893%**, comfortably inside
its own bounds and comfortably outside the stated 1.4–2.8%. Across the whole
`d_proj` prior of §2 the figure moves from 0.959% (d = 5.0 m) to 0.565%
(d = 6.5 m) — the range narrows and *falls* as `d` grows, never approaching 1.4%.

**Where the stated numbers appear to come from.** 1.4% is the seam-direction
circular cap to three significant figures — that is, the strict *upper* bound
quoted as the lower end of the range. 2.8% is exactly twice it, which is the
two-pole total, quoted as a per-pole figure. Both readings are consistent with
the range having been assembled from cap approximations rather than integrated,
and with a factor-of-two bookkeeping slip on "per pole".

**Proposed amendment.** Replace "roughly 1.4–2.8% of the sphere by area, per
pole" in §4.3 with the integrated figure and its provenance: "**0.89% of the
sphere per pole at d = 5.18 m** (0.57–0.96% across the `d_proj` prior), bounded
below by the 0.70% cap at 80.4° and above by the 1.41% cap at 76.3° — the gap
between those two bounds is the scalloping." The qualitative claim in §4.3, which
is the one that matters, is unaffected and is confirmed.

**What the code does meanwhile.** `unlitPolarAreaFraction` integrates the true
boundary. `coverage.test.ts` asserts the computed value, asserts that it lies
strictly between the two bounding caps (the mathematical content of "scalloped,
not circular"), and asserts that the seam cap equals the spec's 1.4% — pinning
the provenance of the stated number rather than silently disagreeing with it.

---

## A-06 — §2: which quadrants a 2-projector install uses is unspecified, and it matters

**Status:** OPEN. Low risk, easy fix. Reported by the forward model.

§2 gives the nominal azimuths as 0°, 90°, 180°, 270° counterclockwise from P1,
and says "2- and 3-projector installs are supported; quadrants go dark. Simulator
must handle N=2,3,4." It does not say *which* quadrants go dark.

For N=3 the question is uninteresting — any three of the four are equivalent up
to a rotation. For N=2 it decides the coverage field:

| Arrangement | Unlit fraction of the sphere |
| --- | --- |
| Antipodal (0°, 180°) | **16.7%** |
| Adjacent (0°, 90°) | **33.8%** |

The antipodal figure has a closed form — two caps of angular radius
`acos(R/d) = 80.4°` centred on opposite points miss exactly the band within 9.6°
of the great circle equidistant from both, whose area fraction is
`sin(9.6°) = 0.167`. The adjacent arrangement leaves twice as much dark and is
not an installation anybody would build.

**Proposed amendment.** Add one clause to §2: a 2-projector install uses opposed
mounts, i.e. azimuths 0° and 180°.

**What the code does meanwhile.** `nominalRig` defaults to slots {0, 2} for N=2
and {0, 1, 2} for N=3, exposes a `slots` override for sites that did something
else, and `scene.test.ts` asserts both the default and the coverage consequence.

---

## A-07 — conventions.ts §R: the `pitch = -elevation` clause contradicts the rest of §R

**Status:** APPLIED to `conventions.ts` §R. This is our own contract document,
not PARAMETERS.md, so a self-contradiction in it is our bug to fix rather than a
question for the author. The clause now reads `pitch = elevation_of_center_from_lens`
with a revision note in the file. Both models had already implemented
`pitch = asin(axis.z)` from the definition and ignored the worked consequence, so
no code changed — but leaving the contract ambiguous would have meant both sides
aiming at a moving target.

**The tension.** §R defines the rotation as `R = Rz(yaw) * Ry(-pitch) * Rx(roll)`
applied to a canonical frame whose optical axis is `+X`, and states — twice, once
in §R and again on `ProjectorPose.pitchDeg` in the boundary types — that
**positive `pitch` raises the optical axis toward `+Z`**. Expanding the product
confirms it: the optical axis is column 0 of `R`, whose `z` component is
`sin(pitch)`.

§R then adds a worked consequence:

> A projector at azimuth `phi` aimed at the sphere centre therefore has
> `yaw = phi + 180` and `pitch = -elevation_of_center_from_lens`.

The `yaw` half checks out. The `pitch` half does not. A lens mounted **above**
the sphere centre must look **down**, so its optical axis has a negative `z`
component, so `pitch = asin(axis.z)` is **negative**. The elevation of the centre
as seen from that lens is also negative. So `-elevation` is **positive**, and the
two halves of §R disagree by a sign.

**Why it has not bitten yet.** PARAMETERS.md §1 and §2 both put the lens and the
sphere centre at 2.1844 m, so the nominal elevation is zero and the clause is
vacuous. It is exercised only when a lens sits at a different height from the
equator — which is to say, only under injected misalignment, or at any real site
where the projectors are not exactly at 7 ft 2 in. That is the worst possible
place for a latent sign error, because it appears exactly when the bench starts
scoring recovery.

**Proposed amendment.** Either delete the clause, or restate it as
`pitch = elevation_of_center_from_lens` — the sign that agrees with the
definition. Recommend restating rather than deleting: a worked consequence is
useful precisely because it is a cross-check.

**What the code does meanwhile.** `packages/solver/src/project.ts` implements the
definitional clauses only. `aimEuler` inverts the rotation directly —
`pitch = asin(axis.z)`, `yaw = atan2(axis.y, axis.x)` — so it is self-consistent
with `rotationMatrix` regardless of how the disputed sentence is read, and the
disputed clause is never evaluated. If `packages/sim` reads it the other way when
building nominal poses, the disagreement shows up as a pitch error of twice the
lens-to-equator elevation and nothing else, which is a distinctive enough
signature to diagnose from the residual scatter.

---

## A-08 — conventions.ts: the observing camera is not specified at all

**Status:** APPLIED. `conventions.ts` gains a §C specifying the camera model —
pose per §R, intrinsics as `fx, fy, cx, cy, k1, k2, p1, p2`, imaging per §I and
§D, with focal and principal point given directly rather than derived from a
field of view and a lens shift. §C also states explicitly that a camera runs §D
in the opposite direction to a projector, and notes that getting that backwards
produces a radially symmetric residual easily mistaken for a focal-length error.
The camera is measurement apparatus, not a property of the installation, so it
stays out of `RigCalibration`.

**Status:** OPEN. Not a defect in the boundary object; a gap the bench must close.

`RigCalibration` describes the rig. It says nothing about the camera that
photographs it, because the camera is metrology rather than deployment. But the
solver's input is camera images, so A and B must agree on a camera model as
surely as they agree on §I and §D, and there is no clause governing that
agreement.

`packages/solver/src/sphere.ts` defines one: the same §R pose convention, the same
§I normalized-coordinate convention (`y` up, `v` down), and the same §D
Brown-Conrady direction, with interior orientation given directly as
`(fx, fy, cx, cy)` rather than through a field of view and a lens shift, because
that is the form a checkerboard calibration produces. That choice is documented
in the module and exported as `CameraIntrinsics`.

**Proposed amendment.** Add a §C to conventions.ts fixing the camera model, so the
agreement is normative rather than incidental. Until then, whichever side
generates simulated camera images must adopt `CameraIntrinsics` as written, and a
disagreement here will look exactly like a geometry bug.

---

## A-09 — §7: the pose-recovery gate cannot be scored in absolute world coordinates

**Status:** OPEN. Affects how the bench must compute a gate, not what the gate is.

§7 sets pose recovery at ≤ 2 mm position and ≤ 0.05° rotation against synthetic
ground truth. Position and scale are genuinely observable — conventions.ts §W puts
the world origin at the sphere centre and PARAMETERS.md §1 fixes the radius, which
pins both. **Global rotation is not.** Rotate every projector and every camera
about the sphere centre by the same rotation and every structured-light
correspondence is unchanged, because the sphere is rotationally symmetric and no
pattern references its texture. §W's "`+X` toward the canonical prime meridian" is
defined by where the imagery is painted, which no projected Gray code can see.

So three rotational degrees of freedom are unobservable to **any** solver, and a
bench that compares recovered orientations to ground truth in raw world
coordinates is measuring the gauge rather than the calibration.

**Proposed amendment.** State in §7 that pose recovery is scored **after** aligning
the recovered rig to ground truth by the global rotation that best matches them —
the standard free-network treatment. Note that position error should be measured
after the same alignment, since a global rotation displaces positions too.

**What the code does meanwhile.** `packages/solver` fixes the gauge explicitly
(minimal inner constraints during the solve, then re-expression in the
PARAMETERS.md §2 nominal frame), reports which axes were gauge-fixed rather than
measured in `SolveDiagnostics`-adjacent output, and its own tests score recovery
both raw and gauge-aligned so the size of the gauge stays visible. With one floor
reference the tilt gauge also contaminates `h_center`; with three or more —
§8 item 1's "floor to each projector lens" — tilt becomes observable and it does
not.

---

## A-10 — §7's unlit-within-the-mask gate cannot be met by the 2- and 3-projector installs §2 says are supported

**Status:** OPEN. Blocking for a gate with no tolerance. Reported by the bench.

**The tension.** Two clauses, both unqualified.

- §2 lists `N_proj` as class `CFG` and says: "2- and 3-projector installs are
  supported; quadrants go dark. Simulator must handle N=2,3,4."
- §7 makes "unlit fraction *within the mask boundary*" a **hard** requirement of
  **0%**, computed inside `mask_lo` rather than over the full sphere.

"Quadrants go dark" and "0% unlit inside the mask" are the same statement about
different regions, and for N < 4 the dark quadrant reaches inside the mask
boundary. Measured by `packages/bench` on the nominal geometry at
`d_proj` = 5.18 m, with the mask read as latitude per §4.4:

| Install | Unlit fraction of the masked domain | §7 gate |
| --- | --- | --- |
| 4 projectors | **0%** | 0% — PASS |
| 3 projectors (slots 0, 1, 2) | **5.92%** | 0% — FAIL |
| 2 projectors, antipodal (A-06) | **12.78%** | 0% — FAIL |

The failure is not a solver defect, an alignment defect, or a modelling choice:
it is what "a quadrant goes dark" means. A three-projector install has one
90-degree wedge of longitude lit by only its two neighbours' skirts, and the
part of that wedge above the mask onset receives nothing at all. No calibration
moves it.

**Proposed amendment.** Qualify the gate by projector count. Either state it as
"0% within the mask boundary **and within the azimuthal coverage of the
installed projectors**", or give per-`N` figures and make the requirement "no
worse than the geometric minimum for the installed `N`". The second is more
useful, because it still catches a *misaimed* four-projector rig — which is what
the gate is for — while not condemning a correctly built three-projector one.

**What the code does meanwhile.** The bench reports the gate for every scenario
and lets it fail, rather than suppressing it for N < 4. Suppressing it would
hide a real property of the install; the results file carries the projector
count next to the number so a reader can see which is which.

---

## A-11 — §7's pose-recovery gate is finer than the measurement §8 prescribes to enable it

**Status:** OPEN. Affects how the pose gate should be stated. Reported by the bench.

**The tension.**

- §7 sets pose recovery at **≤ 2 mm position and ≤ 0.05° rotation** against
  synthetic ground truth.
- §8 item 1 prescribes the measurements that make the vertical half of that
  observable: "Tape measure: floor to sphere center; floor to each projector
  lens; sphere center to each projector lens."

A-09 established that global rotation about the sphere centre is unobservable to
any solver and must be removed before scoring. What A-09 does not say is that
*two* of those three rotational degrees of freedom stop being gauge and start
being **measurements** the moment three or more floor references exist — and a
measurement is only as good as the tape.

Measured by `packages/bench` on its `clean` scenario: zero injected misalignment,
no ambient, no sensor noise, a static camera, four floor references at a 3 mm
one-sigma tape-measure error, converging to an RMS reprojection residual of
**1×10⁻⁴ projector pixels**. The recovered rig still carries:

| Component | Error |
| --- | --- |
| Horizontal position | **0.02 mm** |
| Vertical position | **5.0 mm** |
| Rotation, all four projectors | **0.060°** |
| `h_center` | **3.1 mm** |

The entire residual is one global tilt about a horizontal axis. Its size is
predicted exactly by the reference noise: 3 mm of height error at a 5.18 m
radius is `atan(0.003 / 5.18)` = **0.033°**, and the recovered tilt is that,
within the draw. Two thirds of §7's whole rotation budget, and two and a half
times its position budget, are spent by the tape measure before the solver does
anything.

**Why it does not show up as a visible defect.** Grid-line displacement — the
metric tied to what §7 says an operator actually judges — is invariant to a
global rotation, and on the same scenario it reads **0.065 mm** against a 1.0 mm
gate. So the rig that fails §7's pose gate passes §7's grid gate by a factor of
fifteen. Both numbers are correct; they are measuring different things.

**Proposed amendment.** Either:

(a) state the pose gate **relative to the reference measurements** — "≤ 2 mm and
≤ 0.05° *after removing the global rotation the floor references do not
determine*", which is A-09's alignment extended by one axis and makes the gate a
statement about the solver rather than about the tape; or

(b) tighten §8 item 1 — a 1 mm reference (a laser distance meter rather than a
tape) puts the induced tilt at 0.011° and the gate becomes achievable as
written; or

(c) state plainly that the pose gate presumes reference measurements at a stated
accuracy, and give that accuracy.

Recommend (b) and (c) together: the measurement is cheap to improve and the
presumption should be written down either way.

**What the code does meanwhile.** The bench reports pose error decomposed into
horizontal and vertical components and names the dominant direction, so a
tape-measure-limited failure reads as "vertical (height/h_center)" rather than
as a solver defect. `scenarios[].inputs.floorSigmaM` records the assumed tape
accuracy in every results file.

---

## A-12 — §3.1: lens shift has a nominal and a class but no uncertainty, and that omission decides the §7 rotation gate

**Status:** OPEN. Blocking for the pose-rotation gate. Reported by the solver.

**The tension.** §3.1 gives `shift_v, shift_h` a nominal of 0, a class of
`SOLVE`, and one note: "Non-zero for ceiling mounts." No range, no tolerance.
§7 then sets pose rotation recovery at ≤ 0.05°.

Those two clauses interact, because at this geometry lens shift and pointing are
very nearly the same parameter. The arithmetic is elementary. With
`fov_h` ≈ 33.5° on a 1920-wide raster the focal length is
`(1920/2)/tan(16.73°)` = **3195 px/rad**, and §I makes lens shift a fraction of
the half-image, so `shiftH = 0.01` moves the principal point 9.6 px — worth
`9.6/3195` = **0.172° of yaw**. The only thing that tells a shifted lens from a
rotated one is the second-order difference between translating a principal point
and rotating the whole frustum across a 33° field, which is a small effect
sitting on top of a large one.

The normal equations agree. At the solution, in the diagonally-scaled metric,
the condition number runs `3×10⁷` to `1×10⁸` and the three smallest
eigendirections are dominated by per-projector pointing coupled to shift:

| Scenario | Smallest-eigendirection energy |
| --- | --- |
| `nominal` | yaw 61.8%, pitch 25.5%, `fovH` 4.0%, shift 4.0% |
| `six-cameras` | pitch 64.3%, `shiftV` 14.9%, yaw 11.6%, `fovH` 3.7% |
| `two-cameras` | pitch 52.8%, yaw 40.9%, shift 5.5% |

That is the same signature the bench's own attribution reports from the other
side: `pose_rotation` is 63% pitch.

**The measurement.** Holding `shiftH`/`shiftV` at §3.1's own nominal of zero, on
the twelve-scenario corpus at seed 1234:

| | shift free | shift held at 0 |
| --- | --- | --- |
| Worst pose rotation error | **6.29°** | **0.30°** |
| `handheld` rotation error | 3.55° | 0.16° |
| Worst pose position error | 505.8 mm | **1286.6 mm** |

So the rotation gate is a factor of twenty away from passing, and which side of
that factor the solver lands on is decided entirely by what uncertainty the
document assigns to a parameter for which it assigns none. (The position column
is the other half of the story and is A-13's: with shift no longer available to
absorb the error, it moves into the field-of-view/distance valley instead.)

**Proposed amendment.** Give `shift_h`, `shift_v` a plausible range in §3.1, in
the same spirit as §2's `±1–2°` mount tolerance — the natural statement is that
a rig built to §2 (lens at the equator, aimed at the centre, no ceiling mount)
has zero shift to within some stated fraction, and that a ceiling mount is a
different configuration whose shift is read from the projector rather than
solved. And add one line to §8 item 2: **read the lens shift setting off the
projector's own menu**. It is a number the projector displays, it costs nothing
to write down, and it is currently the least-constrained parameter in the whole
geometric fit.

**What the code does meanwhile.** `packages/solver` keeps `shiftH`/`shiftV`
free, per §3.1's `SOLVE` class. `SolvePriorOptions.shiftSigma` supplies a
documented Gaussian prior on them and is **0 (off) by default**, so nothing in
the shipped behaviour depends on a number this document does not state. A test
pins the mechanism — a tight shift prior must move the recovered *pointing*,
which is the coupling this entry is about — rather than pinning a policy.

---

## A-13 — §3.1 / §8: `fov_h` should be initialised from the throw ratio, not from `d_proj`, and the difference is the largest single term in the pose error

**Status:** OPEN. Blocking for the pose-position gate. Reported by the solver.

**The tension.** §3.1 classes `fov_h` as `SOLVE` and derives it from `T`, class
`CFG` — "read from a hardware spec sheet". §2 declines to settle `d_proj` and
tells the solver to treat it as `SOLVE` with a wide 5.0–6.5 m prior. Nothing
says which of the two an implementation should use to build the nominal field of
view, and the answer changes the recovered geometry by a factor of eight.

The sphere subtends about 19° from a long-throw lens, so `d` and `fov_h` trade
against each other almost exactly: what an image determines well is the ratio,
and what separates them is the ~0.79 m depth swing of §3.3, some 15% of
`d_proj`. AMENDMENTS-adjacent evidence already in `packages/bench/README.md`
shows two calibrations a quarter of a metre apart fitting the same photographs
to within 0.4% of the same residual RMS.

**What we measured this round, and it changes the recommended remedy.**

1. **A prior on `fov_h` does not close the valley, at any width.** Swept at
   one-sigma widths of 0.5, 1, 2, 3 and 4 degrees over the twelve-scenario
   corpus, the worst-case pose position error moved from **639.6 mm to
   622.1 mm** — under 3% — and the median barely at all.

2. **The reason is that the failure is bias, not variance.** The formal
   one-sigma on `fov_h` from the normal equations, with the residual scale taken
   from the fit itself, is about **0.15°**, while the recovered field lands
   **2.5–4.9°** from truth on the scenarios that carry a decode bias. That is a
   twenty-sigma error. A prior at any width `T`'s spec sheet could justify
   (1–2% of `T`, i.e. 0.3–0.7°) is two orders of magnitude weaker than the wrong
   data it would have to argue with, and is simply outvoted.

3. **Holding `fov_h` does work, and that is the point.** On the same corpus:
   `handheld` 639.6 → 71.8 mm, `six-cameras` 346.2 → 166.6, `three-projectors`
   270.2 → 60.6, `no-floor-reference` 391.2 → 133.5. It is an infinitely tight
   prior at a value nearer the truth than the fit is.

4. **But holding it at a value derived from `d_proj` is not available.** The
   `long-throw` scenario is a site whose real geometry is the floor plan's
   6.14 m while its config carries the alignment manual's 5.18 m. A field of
   view derived from 5.18 m is 33.46°; from 6.14 m it is 28.37°. Holding the
   first costs that scenario **500.7 → 793.8 mm**. Encoding one side of a
   conflict §2 explicitly refuses to settle is exactly the failure mode §2 is
   warning about.

The way out is the one §3.1 already implies and never states: **`fov_h` comes
from the lens, not from the distance.** A throw ratio read off a spec sheet is
independent of where the projector ended up standing, so it breaks the
degeneracy with outside information rather than with an assumption.

**Proposed amendment.** Two lines.

(a) In §3.1, say that `fov_h`'s nominal is derived from `T` and **must not** be
derived from `d_proj`, and give `T` a stated tolerance — a zoom lens's throw
ratio is a range, so the tolerance has to cover the zoom setting as well as the
sheet.

(b) In §8 item 2, add the zoom setting to what gets recorded: "Projector make
and model → throw ratio, native resolution, lens shift range" already asks for
the sheet; it needs "and the zoom setting as deployed", because otherwise the
recorded throw ratio is a range and the derived field is only as good as the
widest end of it.

**What the code does meanwhile.** `packages/solver`'s `nominalRig` derives
`fov_h` from `radiusM / distanceM` per A-01 when no field of view is passed, and
documents that a caller holding the spec sheet should pass `fovHDeg` instead.
`packages/bench` does **not** pass it: `run.ts` builds the solver's nominal at
`d_proj`'s documented 5.18 m, so the bench is currently modelling a site that has
not read its own spec sheet. That is a defensible thing to measure and it is not
being changed unilaterally — but every pose-position number in
`bench-results.json` is conditional on it, and the gap between the two readings
is a factor of eight. `SolvePriorOptions.fovHDegSigma` implements the prior and
is 0 (off) by default, because measurement 1 above says a prior of any honest
width is theatre.

---

## A-12 — §7 / §8: the pose gate is a tape-measure gate, not a solver gate

**Status:** OPEN. **This is the most consequential entry in this file.** It says the
headline geometric gate cannot be met by improving the solver, at any camera
resolution, with the measurement instrument §8 prescribes.

**Method.** One scenario (`nominal` archetype, seed 424242), one knob moved at a
time, everything else — rig, injected misalignment, seed, patterns — held fixed.

### Step 1: is it the field-of-view degeneracy?

No. Holding `fovHDeg` makes recovery **five times worse**, and by an identical
amount at both camera resolutions, so it is a fixed bias rather than noise:

| variant | position | rotation | residual |
| --- | --- | --- | --- |
| 320×240, fov free | 27.952 mm | 0.0624° | 0.1336 px |
| 320×240, **fov held** | **141.240 mm** | 0.1298° | 0.1359 px |
| 1280×960, fov free | 4.861 mm | 0.0498° | 0.0657 px |
| 1280×960, **fov held** | **141.341 mm** | 0.1278° | 0.0700 px |

The cause is a divergence between the two `nominalRig` builders: `sim` constructs
`fovH` = 34.0918°, `solver` constructs 33.4610°. Holding the field of view pins it
0.63° from truth and the pose absorbs the error. **The earlier `fov-held`
result that appeared to show a 2.7× improvement was two-camera geometry so poorly
conditioned that a wrong-but-frozen parameter beat a wildly-free one.** It does
not generalise, and it should not have been reported as a headline. See A-13.

### Step 2: is it the sensor?

Partly, and only up to about 640×480:

| camera | position | rotation | residual | correspondences |
| --- | --- | --- | --- | --- |
| 320×240 | 27.952 mm | 0.0624° | 0.1336 px | 9 911 |
| 640×480 | 6.559 mm | 0.0503° | 0.0703 px | 47 639 |
| 1280×960 | 4.861 mm | 0.0498° | 0.0657 px | 168 148 |
| 2560×1920 | 4.423 mm | 0.0483° | 0.0701 px | 761 776 |

The gain saturates hard — 4.3× for the first doubling-of-doubling, then 1.35×,
then 1.10× — and the residual floors at ~0.070 px from 640×480 onward.

It is **precision, not count**. Rendering at 1280×960 while throttling the
correspondence cap back to the 320×240 baseline gives **4.993 mm from 13 357
correspondences**, statistically the same as 4.861 mm from 168 148. Twelve times
fewer points on a finer sensor is as good. Keeping more points on a coarse sensor
would not have helped.

### Step 3: what does the curve asymptote to?

The floor-reference tape measure. Removing each noise source separately, at
640×480:

| case | position | rotation | residual | `h_center` |
| --- | --- | --- | --- | --- |
| baseline: tape σ = 3 mm, sensor noise on | 6.559 mm | 0.0503° | 0.0703 px | 1.32 mm |
| tape σ = 0.05 mm, sensor noise on | 5.029 mm | **0.0041°** | 0.0703 px | 0.01 mm |
| tape σ = 3 mm, **no** sensor noise | 4.375 mm | 0.0483° | 0.0000 px | 1.34 mm |
| **neither** | **0.073 mm** | **0.0008°** | 0.0000 px | 0.02 mm |

The two terms are independent and add in quadrature:
`√(5.029² + 4.375²)` = 6.66 mm against 6.559 observed.

Three conclusions follow, and the third is the important one.

1. **The solver is not the problem.** With both noise sources removed it recovers
   pose to **0.073 mm and 0.0008°** — 27× inside the position gate and 60× inside
   the rotation gate. There is no solver defect here to optimise away.
2. **The rotation gate is almost purely a tape-measure gate.** Tape σ alone moves
   rotation from 0.0041° to 0.0503°, i.e. from comfortably passing to failing, and
   sensor noise barely touches it (0.0483° with a *noiseless* camera).
3. **The asymptotic position floor as camera resolution → ∞ is the tape term,
   ≈ 4.4 mm.** Predicted 4.375 mm from the ablation; measured 4.423 mm at
   2560×1920. §7's gate is 2 mm. **No camera and no solver reaches it while floor
   references carry 3 mm of error.**

### Proposed amendment

Two options, and they are not exclusive.

- **§8 item 1: replace the tape measure with a laser distance meter.** §8 currently
  says "Tape measure: floor to sphere center; floor to each projector lens". A
  hand-held laser measure is ±1 mm over this range and costs about the same as
  lunch. Substituting σ = 1 mm for σ = 3 mm moves the asymptotic floor from
  ≈4.4 mm to ≈1.5 mm, which brings §7's 2 mm gate inside reach. This is the
  single cheapest change available to the project.
- **§7: state the pose gate as a budget with its terms named** — solver,
  sensor, and reference-measurement — rather than a single number. As written,
  the gate reads as a claim about alignment software; the measurement shows it is
  mostly a claim about the instrument used on the visit.

**What the code does meanwhile.** `floorSigmaM` is already a scenario parameter,
defaulting to the 3 mm that a tape measure justifies. Nothing is tuned. The
ablation above is reproducible from `packages/bench` and becomes Experiment 1's
first figure.

---

## A-13 — the two `nominalRig` builders disagree, and it silently poisoned a result

**Status:** OPEN. Reported by the independence critic and confirmed by measurement.

`packages/sim` and `packages/solver` each construct the PARAMETERS.md nominal rig
independently, which is the design working as intended. They disagree:

| quantity | `sim` | `solver` |
| --- | --- | --- |
| `fovH` at nominal | 34.0918° | 33.4610° |
| projector azimuths at N=3 | 0°, 90°, 180° | 0°, 120°, −120° |

The `fovH` gap traces to a `marginFrac` default of 0.02 in
`sim/src/optics.ts` — 2% of headroom around the silhouette that A-01 discusses in
prose but never fixes as a number. The azimuth gap is §2 being silent about N=3,
the same ambiguity A-06 records for N=2.

Neither is a boundary violation: independent construction from the same prose is
exactly what the architecture asks for, and the disagreement being *visible* is
the mechanism working. But an undeclared 0.63° divergence sitting in the one seam
the design exists to keep clean is not harmless — it is what made "hold the field
of view" look like a fix when it is a 5× regression (A-12, step 1).

**Proposed amendment.** Fix `marginFrac` in §3.1 as an explicit documented
constant rather than leaving it to each implementation, and settle the N=3
azimuths in §2. Then add a test asserting both builders agree to a stated
tolerance — comparing *outputs* of two independent implementations is a
legitimate cross-check and does not couple them.
