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

| Entry | Target | Subject | Status |
| --- | --- | --- | --- |
| A-01 | PARAMETERS.md §3.1 / §4.3 / §7 | §3.1 / §4.3 / §7: which raster dimension does the sphere di... | OPEN |
| A-02 | PARAMETERS.md §4.5 / §4.4 | §4.5 / §4.4: bottommask units are inferred, and the inferen... | OPEN |
| A-03 | PARAMETERS.md §7 | §7: the off-sphere flux gate has no stated aspect-ratio dep... | OPEN |
| A-04 | PARAMETERS.md §1 | §1: ρ_R,G,B has no stated plausible range, but the sensitiv... | OPEN |
| A-05 | PARAMETERS.md §4.3 | §4.3: the stated unlit polar area is not reachable from §4.... | OPEN |
| A-06 | PARAMETERS.md §2 | §2: which quadrants a 2-projector install uses is unspecifi... | OPEN |
| A-07 | conventions.ts | conventions.ts §R: the pitch = -elevation clause contradict... | **APPLIED** |
| A-08 | conventions.ts | conventions.ts: the observing camera is not specified at all | **APPLIED** |
| A-09 | PARAMETERS.md §7 | §7: the pose-recovery gate cannot be scored in absolute wor... | OPEN |
| A-10 | PARAMETERS.md §7 | §7's unlit-within-the-mask gate cannot be met by the 2- and... | OPEN |
| A-11 | PARAMETERS.md §7 | §7's pose-recovery gate is finer than the measurement §8 pr... | OPEN |
| A-12 | PARAMETERS.md §3.1 | §3.1: lens shift has a nominal and a class but no uncertain... | OPEN |
| A-13 | PARAMETERS.md §3.1 / §8 | §3.1 / §8: fov_h should be initialised from the throw ratio... | OPEN |
| A-14 | PARAMETERS.md §4.5 | §4.5's worked continuity value is the one for f = 0.04, not... | OPEN |
| A-15 | PARAMETERS.md §7 | §7's seam gates are worded as *discontinuities*, but §3.2's... | OPEN |
| A-16 | PARAMETERS.md §7 / §8 | §7 / §8: the pose gate is a tape-measure gate, not a solver... | **SUPERSEDED** |
| A-17 | PARAMETERS.md | the two nominalRig builders disagree, and it silently poiso... | OPEN |
| A-18 | PARAMETERS.md | correcting A-16: the pose gate is a LENS-KNOWLEDGE gate, an... | OPEN |
| A-19 | PARAMETERS.md §2 / §3.1 | §2 / §3.1: the nominal rig has two numbers the spec never s... | OPEN |
| A-20 | conventions.ts | conventions.ts: the nominal rig construction was not specif... | **APPLIED** |
| A-21 | PARAMETERS.md §7 | §7's black-uplift gate of 1.20 is unsatisfiable under the r... | OPEN |
| A-22 | PARAMETERS.md | the projector's primaries are not stated anywhere, and both... | OPEN |
| A-23 | PARAMETERS.md §2 / §3.1 / §8 | reading the primary alignment manual: three confirmations, ... | OPEN |
| A-24 | PARAMETERS.md §7 | §7's two seam gates are not independent, and the chromatic ... | OPEN |
| A-25 | PARAMETERS.md §4.5 / §8 | §4.5 states the blend's width and shape but not its ANCHOR,... | OPEN |
| A-26 | PARAMETERS.md §8 | the ramp width is worth 8x and the ramp shape 1.6x, so §8 i... | OPEN |
| A-27 | PARAMETERS.md §3.2 | wp_i is a derived quantity and should be marked as one | OPEN |
| A-28 | PARAMETERS.md §10 | §10's fourth-ranked risk is inert against every §7 gate, an... | OPEN |
| A-29 | PARAMETERS.md §7 / §8 | the black-uplift gates cannot be planned one constant at a ... | OPEN |

**A note on citing these entries mechanically.** `gate-waivers.json` cites an
entry by id AND by a fragment of its title, and `packages/bench/src/waivers.ts`
refuses a citation that resolves to anything other than exactly one heading. The
belt and braces are not decoration: A-12 and A-13 were each used for two
different entries until the duplicates were renumbered to A-16 and A-17, and a
waiver that had cited "A-12" alone would have silently changed which argument it
rested on when the renumbering happened. The tool also reads the `**Status:**`
line, so an entry that becomes `ACCEPTED`, `REJECTED`, `APPLIED` or `SUPERSEDED`
stops covering the gate that cites it — which is the point. A-16 is the worked
example: it was superseded by A-18 four hours after `gate-waivers.json` first
cited it, and the citation failed the build rather than continuing to rest on a
conclusion the register had withdrawn.

---

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

## A-14 — §4.5's worked continuity value is the one for `f` = 0.04, not the "generous f = 0.05" the sentence claims

**Status:** OPEN. Not blocking; the conclusion §4.5 draws is unaffected. Reported by the forward model.

**The tension.** §4.5 rejects ambient light as an explanation for the blend gamma
of 0.8 with this arithmetic:

> Including an additive floor `f`, continuity requires `V^γ = (1−2f)/(2(1−f))`;
> at γ=2.2 and a generous f=0.05 this gives V=0.716 against 0.730 with no floor
> at all. A 2% shift.

Evaluating §4.5's own formula at §4.5's own `f` = 0.05 gives **0.71202**, not
0.716. The stated 0.716 is what the formula gives at **`f` = 0.04** — which is
exactly §5's nominal `E_amb`. So the sentence's "generous f = 0.05" and its
quoted result do not correspond, and the quoted result is the *nominal* ambient
rather than a generous one.

| `f` | `V` | Shift from 0.72974 |
| --- | --- | --- |
| 0 | 0.72974 | — |
| 0.04 (§5 nominal `E_amb`) | **0.71576** | 1.92% |
| 0.05 ("generous", per §4.5) | **0.71202** | 2.40% |

**Why it does not matter, and why it is recorded anyway.** Both readings give a
shift of about 2%, and §4.5's conclusion needs only that the shift is far too
small to move 0.4545 to 0.8 — a 76% change. The conclusion stands under either
number. But §4.5 is the passage that *rejects* a hypothesis, and a rejection
whose arithmetic does not reproduce is the kind that gets re-litigated by the
next person to read it.

**Proposed amendment.** Either change "a generous f=0.05" to "f = 0.04, §5's
nominal ambient" and keep 0.716, or keep f = 0.05 and change the value to 0.712.
Recommend the first: tying the figure to §5's own nominal makes the paragraph a
cross-reference rather than a free parameter.

**What the code does meanwhile.** `packages/sim/src/blend.ts`
`continuityEncodedValue` implements the formula as stated and takes `f` as an
argument. `test/blend.test.ts` asserts BOTH values to nine digits, asserts that
the f = 0.04 case is the spec's quoted 0.716, and asserts the conclusion — that
either shift is about 2% and 0.8 is nowhere near either — so the discrepancy
cannot drift in either direction without a test failing.

---

## A-15 — §7's seam gates are worded as *discontinuities*, but §3.2's headline artifact is not one

**Status:** OPEN. **Blocking for what the seam gates actually certify.** Reported by the forward model.

**The tension.** Two clauses that appear to be about the same artifact are about
different ones.

- §7 gates "Seam luminance **discontinuity** ≤ 2% of local mean" and "Seam
  chromaticity **discontinuity** ΔE2000 ≤ 1.0", with the luminance gate's basis
  given as "Weber fraction for a **step** in a smooth field".
- §3.2's worked example — the passage rev 2 exists for — produces a 6% blue
  deficit that "reads as a **yellow band**".

A band is not a step. In this rig's geometry the difference is not a quibble: at
the equator the two-projector overlap spans **71° of longitude**, and a
per-channel gamma divergence produces a deficit that rises smoothly from zero at
one edge of that overlap to its maximum in the middle and back to zero at the
other. There is no discontinuity anywhere in it. Any estimator that measures a
step — which is what §7 asks for, and what the underlying field's own 2:1
incidence falloff *forces*, since a naive max-minus-min reports 47% on a perfect
rig — is blind to it by construction.

**The measurement.** `packages/sim` on the nominal rig, with §3.2's own worked
divergence applied (every projector's blue channel at γ = 2.4, compositor still
encoding at 2.2), all four §7 gates PROVISIONAL:

| Metric | Channel-matched nominal | §3.2's worked divergence |
| --- | --- | --- |
| Seam luminance discontinuity | 0.00137 | 0.00138 |
| Seam chromaticity discontinuity | 0.028 | **0.029** |
| Luminance shift from divergence | 0 | 0.0072 |
| Chromaticity shift from divergence | 0 | **3.88** |

So the rig carrying §3.2's artifact **passes every scored gate in §7**, and the
seam-chromaticity gate — the one rev 2 added specifically for this artifact —
moves by 0.001 ΔE2000 when the artifact is switched on.

**Proposed amendment.** Split the seam gates in two, because they are two
different measurements with two different psychophysical bases:

(a) a **discontinuity** gate, as written, at 2% and ΔE2000 1.0, which is a
Weber-fraction argument about a step and catches misregistration, a hard mask
edge, and a gain mismatch between neighbours; and

(b) a **band** gate over the whole overlap region, whose basis is not Weber's
fraction but the eye's sensitivity to a low-spatial-frequency chromatic
gradient — a different and considerably *looser* threshold in luminance and a
comparably tight one in chroma. §3.2's claim that "the eye is more sensitive to a
chromatic edge than a luminance one" is the right instinct; the gate that follows
from it has to be stated over a region rather than at a point.

Setting a number for (b) needs the §8 visit: it is a psychophysical threshold for
a gradient of unknown size on a surface of unknown gloss under lighting of
unknown colour, and inventing one now would be exactly the failure mode the phase
gate exists to prevent.

**What the code does meanwhile.** `packages/sim/src/metrics/photometric.ts`
implements (a) as the two SCORED gates §7 states, with a documented
trend-subtraction estimator and a per-track CONTROL that measures the estimator's
own noise floor on the same field. It implements (b) as two UNSCORED readings —
the field rendered twice, once with the rig's real thirty-six transfer terms and
once with every channel forced to agree — reported beside the §7 gate for scale
but never allowed to decide a verdict, because §7 sets no gate on them.

---

## A-16 — §7 / §8: the pose gate is a tape-measure gate, not a solver gate — **SUPERSEDED, see A-18**

**Status:** **SUPERSEDED by A-18.** Its measurements are reproducible and its
floor is real, but its headline conclusion is wrong and its proposed remedy would
have bought nothing. Retained in full, uncorrected, because a register that
quietly deletes its mistakes is not a register. Read A-18 before acting on
anything below.

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

## A-17 — the two `nominalRig` builders disagree, and it silently poisoned a result

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

**What the code does now.** Both quantities are pinned in
`packages/calibration/src/conventions.ts` §N as literals — the boundary object
holds no mathematics, so it states the value and each side derives its own
frustum and its own azimuths from it. `packages/sim/src/optics.ts` reads
`NOMINAL_SILHOUETTE_MARGIN_FRAC` for its default headroom; `packages/solver`'s
`nominalRig` applies the same headroom to the tangent of the silhouette's
angular radius and places its projectors in §2's slots rather than at 360/N.
`packages/bench/test/nominal-agreement.test.ts` compares the two OUTPUTS at
three rasters, four distances and N = 2, 3, 4, and its failure message says what
a divergence means and why the fix is never to make one side call the other.
The remaining divergence — `sim` reads `d_proj` as a horizontal radius, `solver`
as the 3D distance §2's wording gives — is pinned there too, at its closed form
`d - sqrt(d^2 - z^2)`: 39 um at this corpus's height scatter, 3.9 mm at a 0.2 m
ceiling mount, which is ABOVE the §7 pose gate and is the sentence to put in
front of whoever adds a ceiling-mount scenario. See A-19 and A-20.

---

## A-18 — correcting A-16: the pose gate is a LENS-KNOWLEDGE gate, and the tape is only the floor beneath it

**Status:** OPEN. Supersedes A-16. Raised by an independent critic and confirmed
by a second, independent measurement in A-13.

A-16 concluded that §7's pose gate is bound by the floor-reference tape measure,
and proposed buying a laser distance meter for §8 item 1. **That conclusion does
not survive scrutiny, and the remedy would have moved the corpus worst case from
504 mm to 504 mm.** Three errors, in increasing order of seriousness.

**1. A-16's step 1 held `fovHDeg` at a value it knew to be wrong.** It concluded
"the field-of-view degeneracy does not explain it" from holding the field of view
at the *solver's* nominal — which the very same entry (A-17) records as 0.63°
from truth. Holding a parameter at a known-wrong value measures whether the wrong
value hurts. It says nothing about whether the parameter is degenerate. The test
that answers the actual question is to hold it at **truth**, as a diagnostic:

| scenario | fov free | held at solver nominal | **held at TRUTH** |
| --- | --- | --- | --- |
| s01-nominal | 17.11 mm | 117.24 mm | **2.03 mm / 0.0334°** |
| s06-six-cameras | 426.54 mm | 141.06 mm | **11.13 mm** |
| s09-long-throw | 331.57 mm | 791.15 mm | **13.07 mm** |

One scalar per projector removes **88–97% of the position error** and costs
0.3–3.5% of residual RMS. Two calibrations 415 mm apart fit the same photographs
to within 3% of each other — the definition of a degeneracy.

Note the first row: **2.03 mm and 0.0334°, at 320×240, with the 3 mm tape still
in place.** §7's gate is essentially reachable today if the lens is known. That
single number refutes A-16's thesis on its own.

**2. A-16 generalised from one archetype.** It measured `nominal` only. Across
the corpus the effect changes sign: holding fov is 6.9× worse on s01, 3.0×
*better* on s06, 2.4× worse on s09.

**3. A-16 measured at an operating point the corpus does not use.** Its steps 2
and 3 ran at 640×480 through 2560×1920; every scenario in the corpus runs at
320×240. Removing sensor noise at high resolution also removes the excitation of
the fov valley, so of course the remainder is tape. **A-16 found the floor and
mistook it for the ceiling.** The tape term is ~2–4.4 mm — real, and right at the
gate — while the observed worst case is 504 mm, two orders of magnitude above it.

### What is actually happening

A causal chain, each link measured:

1. Handheld motion biases the decode — median error **4.50 px** against **0.23 px**
   with motion off, and it is a coherent bias within each (camera, projector)
   pair rather than noise.
2. That bias drags the recovered `fov_h` **2.5–4.9° from truth**, against a formal
   one-sigma of 0.15° from the normal equations. A twenty-sigma error.
3. `fov_h` error becomes radial position error through the subtense relation
   `Δd/d = Δfov / (2·tan(fov/2))`, predicting the observed radial component to
   within 5–16% in sign and magnitude on every scenario and both seeds.

Which is why **a prior on `fov_h` does not close the valley at any width**: swept
at one-sigma widths of 0.5° to 4°, the worst case moved 639.6 → 622.1 mm, under
3%. A prior a spec sheet could justify (0.3–0.7°) is two orders of magnitude
weaker than the biased data it would have to argue with, and is simply outvoted.

### Proposed amendment

**`fov_h` comes from the lens, not from the distance — say so in §3.1.** §3.1
already classes `T` as `CFG`, "read from a hardware spec sheet", and derives
`fov_h` from it. But §2 also declines to settle `d_proj`, and nothing says which
of the two an implementation should build the nominal field of view from. The
answer changes the recovered geometry by a factor of eight.

Deriving `fov_h` from `d_proj` is actively unsafe: the `long-throw` scenario
models a site whose real geometry is the floor plan's 6.14 m while its config
carries the alignment manual's 5.18 m. Fov from 5.18 m is 33.46°; from 6.14 m it
is 28.37°. Holding the first costs that scenario 500.7 → 793.8 mm. That is
encoding one side of a conflict §2 explicitly refuses to settle.

A throw ratio is a property of the lens and is independent of where the projector
ended up standing, so it breaks the degeneracy with **outside information** rather
than with an assumption.

**The §8 consequence, and the correction to A-16's shopping list.** A-16 nominated
§8 item 1 (the tape measure). The high-value item is **§8 item 2 — "Projector make
and model → throw ratio, native resolution, lens shift range"** — which is free,
already on the checklist, and worth 88–97% of the pose error. The laser measure
remains worth having, but it buys the last few millimetres, not the first five
hundred. Sequence accordingly.

---

## A-19 — §2 / §3.1: the nominal rig has two numbers the spec never states, and both implementations had to guess

**Status:** OPEN. Reported by the independence critic, confirmed by measurement,
and worked around in `conventions.ts` (see A-20) until the author decides.

This is the spec-facing half of A-13. A-13 records the *symptom* — two
`nominalRig` builders 0.63 degrees apart — and this entry states what
PARAMETERS.md would have to say for the symptom to be impossible.

**1. §3.1 does not say how much room to leave around the silhouette.** A-01
established that the sphere's silhouette is inscribed in the raster's MINOR
dimension. It does not say whether the inscription is exact. Exact inscription
puts the limb on the raster edge, where §4.1's limb test and the raster-bounds
test disagree in the last bit and coverage develops a ragged fringe, so
`packages/sim` left 2% of headroom and `packages/solver` left none. Both are
honest readings. The gap is 0.63 degrees of horizontal field at the §2 nominal
(34.0918 against 33.4610), which is four times the zoom repeatability the corpus
injects, and holding the field of view at the wrong one of them is a 5x
regression in recovered pose (A-12, step 1).

*Proposed amendment.* State the headroom in §3.1 as a number, in the same
sentence that states the inscription. Any value in the region of a couple of
percent works; what matters is that it is stated once rather than chosen twice.

**2. §2 does not say which quadrants go dark at N=3.** §2 gives four slots at
0/90/180/270 and says "2- and 3-projector installs are supported; quadrants go
dark". A-06 already records that this is undecided for N=2 and that the answer
changes the coverage field by a factor of two. A-06 then dismisses N=3 as
uninteresting — "any three of the four are equivalent up to a rotation" — and
that is true of the COVERAGE FIELD and false of everything else. Three
projectors at 0/90/180 and three at 0/120/240 are not related by a rotation:
one drops a quadrant from a standard rig, the other respaces the surviving
mounts. `packages/sim` built the first, `packages/solver` built the second, and
the disagreement is 30 degrees of azimuth handed to a bootstrap that has no way
to know about it.

*Proposed amendment.* Add one clause to §2 covering both cases: the installed
projectors occupy a subset of the four nominal slots, and the remaining mounts
are not respaced. That is one sentence and it settles A-06 as well.

**Why this is filed even though the code now agrees.** Independent construction
from the same prose is the architecture working; the divergence being VISIBLE is
the mechanism working. What was wrong was that it was undeclared for a whole
round, and the reason it could be undeclared is that the document is silent.
Pinning the values in our own contract (A-20) removes the divergence without
removing the question, and the question belongs to the author.

---

## A-20 — conventions.ts: the nominal rig construction was not specified at all

**Status:** APPLIED. `conventions.ts` gains a §N specifying the two quantities
A-19 asks PARAMETERS.md to state: the silhouette headroom
(`NOMINAL_SILHOUETTE_MARGIN_FRAC = 0.02`) and the azimuth slots an install of N
projectors occupies (`NOMINAL_SLOTS_BY_COUNT`, N=3 -> {0,1,2}, N=2 -> {0,2}).
Both are literals — the package holds no mathematics — and both sides still
build their own rigs from them. `CONVENTIONS_VERSION` moves to
`sphere-sim/conventions@3`.

Per this file's own rule, `conventions.ts` is our contract rather than the spec,
so an ambiguity in it that both sides are implementing independently is our bug
to fix. Leaving it unstated meant the two models were aiming at a moving target
in the one seam the design exists to keep clean.

**What changed in the code.** `packages/solver`'s `nominalRig` previously built
`fovV = 2*asin(R/d)` exactly and spaced N projectors at 360/N. It now applies
§N.1's headroom to the tangent of the silhouette's angular radius and takes
§N.2's slots. `packages/sim` previously carried the 2% as a local default in
`optics.ts` and the slot table as a local rule in `scene.ts`; both now read the
boundary object's literal. Neither side calls the other, and neither side gained
a line of the other's arithmetic.

**What it costs.** Every pose number in `bench-results.json` moves, because the
solver's initialisation moves: the nominal field of view it starts from is now
0.63 degrees closer to the rig the forward model actually built. That is a
change in the measurement apparatus and it is recorded here rather than
presented as an improvement.

---

## A-21 — §7's black-uplift gate of 1.20 is unsatisfiable under the reading §8 prescribes the measurement for

**Status:** OPEN. Blocking for what the black-uplift gate certifies. Reported by the forward model.

**The tension.**

- §7 gates "Black uplift ratio, overlap ÷ single ≤ 1.20", basis "Below where an
  overlap band reads as a visible rectangle in dark content."
- §8 items 8 and 9 prescribe the measurement: "Full black, projectors **on**" and
  "Full black, projectors **off**", and calls them "the highest-value pair in the
  list: their difference is the black-floor term that drives every overlap
  artifact."

Their *difference* is the projector contribution with ambient removed. But in
dark content each projector emits `gain × blackFloor` regardless of blend weight,
so `n` projectors deliver `n` times what one delivers, and the ratio is **exactly
`n`** — 2.00 against a gate of 1.20 — for any black floor, any gain, and any
geometry where the two contributions are comparable. As a gate it is a constant
equal to the projector count, and no calibration, no blend and no measurement can
move it.

Including ambient makes it finite and informative. Measured by `packages/sim` on
the nominal rig, all values PROVISIONAL:

| Reading | `E_amb` = 0.04 (§5 nominal) | `E_amb` = 0.01 (§5 floor) |
| --- | --- | --- |
| Observed ratio, ambient included | **1.016** | **1.060** |
| Ambient removed (§8 frames 8 − 9) | 1.9995 | 1.9995 |

So whether the gate passes is decided almost entirely by `E_amb` — class ASSUME,
plausible range 0.01–0.15, a factor of fifteen — and hardly at all by the twelve
black floors the gate appears to be about.

**A second finding, which is a property of the sphere and not of the projectors.**
The observed ratio is far below 1.20 even at the dark end, and part of the reason
is geometric rather than photometric: on a sphere the overlap sits exactly where
*both* projectors are at their most oblique. At the equatorial seam each
contributes at `cos(incidence)` = 0.61 against 1.0 at its own sub-projector point,
so the doubled black floor arrives attenuated by the same factor that dims
everything else there. The "visible rectangle" of §7's basis is a flat-screen
artifact; on a silhouette-masked sphere each projector's footprint edge *is* the
limb, where `cos(incidence)` → 0, so the black floor cannot produce a hard edge on
the sphere at all. It can and does produce one on the floor around it, which
`render.ts` already models.

**Proposed amendment.** State which reading the gate is against. Recommend the
ambient-inclusive one, since visibility is contrast against a surround and the
surround has the room in it — and then say so explicitly, because a gate that
depends on `E_amb` should not look like a gate on the projectors. Add to §7's
basis column that the figure presumes an ambient level, and name it.

**What the code does meanwhile.** The observed (ambient-inclusive) ratio is the
SCORED metric; the ambient-removed ratio is reported beside it as an explicitly
unscored companion whose note says it is exactly the projector count by
construction. Both are computed against the strongest single contributor **at the
same point**, not against a mean over the single-projector region — comparing
region means would compare the seam against a sub-projector point and report a
factor-of-two geometry difference as a photometric one.

---

## A-22 — the projector's primaries are not stated anywhere, and both ΔE2000 gates depend on them

**Status:** OPEN. Low risk today, unbounded risk after the §8 visit. Reported by the forward model.

**The gap.** §3.2 gives per-channel gammas, black floors and gains, and a white
point in kelvin. §7 gates two metrics in ΔE2000. Converting linear RGB to CIE XYZ
— the first step of any ΔE — requires the **chromaticity of each primary**, and
that appears nowhere in PARAMETERS.md. §9 lists "spectral rendering — RGB only, so
metamerism between projector primaries and ambient light is approximated, not
simulated" as a known omission; this is the other half of the same hole, and
unlike the metamerism it changes a gated number directly.

`wp_i` does not close it. A white point constrains where R + G + B lands, not
where R lands. Two projectors with identical white points and different primaries
give different ΔE2000 for the same seam, and the difference is largest for
saturated content — which is most SOS content, since the datasets are false-colour.

**Proposed amendment.** Add a row to §3.2 for the primaries' CIE 1931 `xy`
coordinates, class `CFG` (a projector's datasheet states them) falling back to
`ASSUME`, and add one line to §8 item 2: record the projector's **colour gamut**
from its spec sheet alongside the throw ratio and native resolution. It is one
more number off a page somebody is already reading, and until it exists every
ΔE2000 in the project is conditional on a substitution nobody has agreed to.

**What the code does meanwhile.** `packages/sim/src/color.ts` takes the RGB→XYZ
matrix as a parameter and defaults to Rec.709/sRGB at D65, documented at the top
of the module as class ASSUME with the reasoning: it is the only primary set the
cited documents imply, since SOS content is authored as ordinary RGB imagery. The
choice is named in every photometric metric's note and in the metric set's
provenance block, so no ΔE leaves the package without it attached. A real DLP with
a white segment in its colour wheel is materially different, and swapping the
matrix is a one-argument change.

---

## A-23 — reading the primary alignment manual: three confirmations, one `DOC`-vs-`DOC` conflict, and two facts the spec does not carry

**Status:** OPEN. Raised after fetching
`https://sos.noaa.gov/support/sos/manuals/alignment/all/`, which PARAMETERS.md
cites in §Sources but which had not been read directly — every earlier entry in
this register worked from PARAMETERS.md's summary of it.

PARAMETERS.md remains authoritative. Nothing below has been applied.

### Confirmed verbatim — no change needed

- **`d_proj`, alignment-manual reading.** "The projectors are located about 17
  feet away from the center of the sphere." Exactly as §2 records, including the
  hedge "about". The §2 conflict with the floor plan stands unresolved.
- **Projector azimuths.** "mounted approximately 90 degrees apart from each
  other" — §2's 0/90/180/270 with its ±1–2° mount tolerance.
- **`h_center` is measured to the equator.** "Measure the height (in inches) from
  the ground to the sphere's equator", and, if vertical lines diverge or
  cross-hatch, "consider adding or subtracting 1 inch from this measurement and
  then re-entering it into the SOS configuration file." §1's note paraphrases
  this accurately, and "equator" and "centre" are the same height for a sphere.
- **No published tolerance.** §7's "NOAA publishes no numeric alignment
  tolerance — the documented standard is that an experienced operator judges the
  image continuous" is exactly right. The manual's success criteria are "the red
  ball does not overshoot the sphere on any side", grid lines "line up exactly",
  and vertices "in alignment". All visual, all unquantified.
- **Three stages, in order.** Step 7 Red Ball, Step 8 Grid Alignment, Step 9
  Vertex Tweaking — the structure §3.1 describes when it says solving `k1, k2`
  is "what collapses their three stages into one".
- **No throw ratio, lens, projector model, or resolution anywhere in the
  manual.** This matters: A-18 nominates §8 item 2 ("Projector make and model →
  throw ratio") as the highest-value item on the ground-truth checklist, worth
  88–97% of the pose error. Confirmed that no document supplies it, so the visit
  genuinely has to read the label off the projector.

### The conflict: sphere diameter, `DOC` against `DOC`

The manual says **"6 foot diameter sphere"**. PARAMETERS.md §1 gives
`D_sphere` = **1.7272 m (68 in)**, class `DOC`. Those differ by four inches.

**PARAMETERS.md is right, and its own §4.3 proves it.** The coverage limits in
§4.3 are a function of `R/d`, so they pin the radius:

| Diameter | `R` | Meridian limit | Seam limit |
| --- | --- | --- | --- |
| **68 in (PARAMETERS.md)** | 0.8636 m | **80.4029°** | **76.3627°** |
| 72 in (manual's "6 foot") | 0.9144 m | 79.8326° | 75.5435° |
| §4.3 states | — | **80.4°** | **76.3°** |

§4.3's figures reproduce the 68-inch sphere to four significant figures and miss
the 72-inch one by 0.57° and 0.82°. `packages/sim` independently reproduces
80.4029° and 76.3627° by bisection on the general vector limb test, so the whole
geometric model is consistent with 68 in and only 68 in.

The manual's "6 foot" is best read as colloquial rounding of a 5 ft 8 in sphere —
the same register as "about 17 feet".

**Proposed amendment.** Add one line to §1 noting that the alignment manual says
"6 foot" and that 68 in is nevertheless correct, with §4.3's arithmetic as the
reason. A `DOC` value contradicted by a `DOC` source should say so in the row,
even when the resolution is clear, because the next reader will hit the same
sentence and have to redo this.

### Two facts the spec does not carry, both worth adding

1. **Twenty minutes of projector warm-up is prescribed.** "It is recommended that
   the projectors are on for about 20 minutes before starting alignment."
   §9 lists "Lamp warm-up drift and long-term aging" as *not modelled* and treats
   it as a minor omission. The manual makes warm-up a procedural precondition,
   which means the drift is large enough that NOAA tells operators to wait it
   out. That promotes it from an omission to a documented, quantified-in-time
   effect, and it belongs in §8's capture checklist as a precondition on every
   photometric frame — the 35-frame sequence is worthless if it starts cold.
2. **The procedure takes 1–2 hours for a first-time user, 15 minutes to 1 hour
   for an experienced operator.** PARAMETERS.md carries no baseline for what the
   current process costs. This is the number any claim about the solver's value
   has to beat, and it should be recorded in the spec rather than inferred, so
   that a future comparison is against a cited figure instead of a recollection.


---

## A-24 — §7's two seam gates are not independent, and the chromatic one is the looser

**Status:** OPEN. Blocking for what the pair of seam gates certifies. Reported by
Experiment 2.

**The tension.** §7 sets two seam gates and gives the second an explicit rationale:

> **Seam chromaticity discontinuity — ΔE2000 ≤ 1.0.** Conservative — ΔE 1.0 is the
> classic just-noticeable difference under ideal conditions. The eye is more sensitive
> to a chromatic edge than a luminance one, **so this gate should be at least as tight
> as the luminance gate, not looser.**

ΔE2000 is not a chroma metric. It contains ΔL', and on a neutral field it is
*dominated* by it. So a purely photometric artifact — a misregistration, a gain
mismatch, anything that changes brightness without changing hue — registers on both
gates, and the arithmetic decides which trips first.

At PARAMETERS.md §8 item 13's mid-gray, L\* ≈ 76 and a 2% luminance step is
`ΔL* = (116/3)·(Y/Yn)^(1/3)·(ΔY/Y)` ≈ 0.61. ΔE2000's `S_L` at that lightness is 1.384,
so the step measures **ΔE2000 0.44**. Measured across Experiment 2's whole sweep, the
ΔE 1.0 contour sits at **2.27× the registration error** of the 2% luminance contour, at
every width and every ramp shape:

| ramp width | 2% luminance contour | ΔE2000 1.0 contour | ratio |
| --- | --- | --- | --- |
| 5 deg | 1.53 mm | 3.47 mm | 2.27 |
| 20 deg (nominal) | 6.21 mm | 14.10 mm | 2.27 |
| 40 deg | 12.74 mm | 28.79 mm | 2.26 |

So the gate §7 intends to be the tighter of the two is **2.3x looser** for this class
of artifact, and it can never bind: any artifact that fails it has already failed the
luminance gate by a factor of two.

**Proposed amendment.** State the chromaticity gate on a difference that is actually
chromatic — ΔE2000 with `kL` set high enough to suppress the lightness term, or the
`a*b*` distance alone — and keep 1.0. Or keep ΔE2000 and set the threshold near 0.44 so
the two bind together on a neutral artifact. The first is the better reading of §7's
own sentence, because it makes the two gates measure different things rather than the
same thing twice at different thresholds.

**What the code does meanwhile.** `packages/sim/src/color.ts` implements full ΔE2000
including `kL`, `kC`, `kH`, and `metrics/photometric.ts` gates on the default
`kL = 1` exactly as §7 words it. Experiment 2 reports both contours side by side so the
2.27 ratio is visible rather than inferred.

---

## A-25 — §4.5 states the blend's width and shape but not its ANCHOR, and the anchor decides where the artifact is

**Status:** OPEN. **Blocking for what the seam gates can see at all.** Reported by
Experiment 2.

**The gap.** §4.5 gives the blend a shape (`w(θ)`, "cosine ramp", ASSUME, "shape
unpublished"), a width (`w_width ~ 20 deg`, ASSUME) and an exponent (`γ_blend` 0.8,
DOC). It does not say **where the blend region is**. Two readings are consistent with
every word of it and they put the artifact in different places:

- **Footprint-edge anchored** — each projector fades in from its own limb, inward over
  `w_width`. This is what `packages/sim/src/coverage.ts` implements and what "each
  projector fades out toward the edge of what it can reach" means.
- **Bisector anchored** — each projector fades out symmetrically about the seam
  bisector, over `w_width`.

**Why it is not a detail.** At the equator two adjacent projectors overlap over
70.8 degrees of longitude. Under the footprint-edge reading at the nominal 20-degree
width, both raw weights are clamped at 1 across a **31-degree plateau** in the middle
of that overlap, normalized to 0.5/0.5 — so §7's hand-over, the longitude where the two
normalized weights are equal, sits in the middle of a region where the weight gradient
is exactly zero. Displacing a constant produces a constant. **No misregistration of any
size can produce a step where §7 measures one**, and the artifact instead appears as
two bands 15-25 degrees away, outside the estimator's entire window. Measured: a 16 mm
misregistration moves §7's seam luminance from 1.37e-3 to 1.76e-3 — below the
estimator's own 2.2e-3 control floor — while the field carries a 5.2% band 12 degrees
wide.

Under the bisector reading the crossfade would sit exactly where §7 looks, where both
projectors have equal incidence (`cos` 0.61 at the bisector, by symmetry), and both
gates would be measuring the thing they are named after.

The two readings also differ on sharpness. Footprint-edge anchoring puts the entire
crossfade in the region §4.3 calls degenerate — the fading-in projector is at its own
limb, where `cos(incidence)` approaches zero — which is why widening the ramp *reduces*
the fraction of the sphere lit at below §4.3's `cos` 0.2 (5.41% at 5 degrees to 5.05%
at 40, against a blend-independent floor of 4.76%).

**Proposed amendment.** Add one clause to §4.5 naming the anchor, and one line to §8
item 13: the blend characterization frame should cover enough of the overlap to show
**where** the crossfade sits, not only how wide it is. A photograph of the seam
bisector alone cannot distinguish the two readings.

**What the code does meanwhile.** `coverage.ts` implements the footprint-edge reading
and documents it as a choice at the point where it is made. Experiment 2 measures the
consequence rather than assuming it away, and `docs/EXPERIMENT-2.md` states that its
whole estimator design follows from this one unstated clause.

---

## A-26 — the ramp width is worth 8x and the ramp shape 1.6x, so §8 item 13 should say which to get right

**Status:** OPEN. Low risk, cheap to act on. Reported by Experiment 2.

§8 item 13 asks one photograph to yield two things: "→ `w(θ)` shape and `w_width`".
They are not equally valuable.

Measured over Experiment 2's sweep, the registration error a seam absorbs before the
artifact reaches §7's 2% figure:

| what changes | range | effect on tolerance |
| --- | --- | --- |
| `w_width` | 5 to 40 degrees (A-04's inferred range) | **8.3x** |
| `w(θ)` shape | linear / cosine / smoothstep / gaussian | **1.63x** |
| `γ_blend` | 0.5 to 1.5 | 1.45x, and 0.8 is already near the optimum |

The shape ordering is gaussian, smoothstep, cosine, linear, and the linear ramp is the
outlier rather than the others being close: with `γ_blend` = 0.8 applied to the weight,
a linear ramp has a slope discontinuity where it meets the clamped plateau, and its
artifact is concentrated into 4.5 degrees of arc instead of spread over 12.

**Proposed amendment.** In §8 item 13, say that the width is the number the frame must
determine and the shape is a bonus — and that a site's own `blend` config values should
be read off the machine alongside (§8 item 5 already asks for `gamma` and `bottommask`;
the blend width belongs in the same list).

**What the code does meanwhile.** Both are configurable on `BlendCalibration` and
neither has a default that is not PARAMETERS.md's own. Experiment 2 sweeps all four
shapes at eleven widths rather than picking one.

---

## A-27 — `wp_i` is a derived quantity and should be marked as one

**Status:** OPEN. Low risk. Reported by Experiment 3.

§3.2 lists `wp_i` (white point, 6500 K) as a parameter with a nominal and a class
`ASSUME`, and in the same row says "Derived from `g`; tracked separately for
reporting." Both cannot be true of a value a model consumes: the three gains ARE the
white point, so a stored `whitePointK` that disagrees with them is over-specified, and
a model that applied both would be applying a colour shift twice.

Experiment 3 swept it across 5500-7500 K and every response moved by **exactly zero**.
That is the correct behaviour and it is worth recording, because a zero in a
sensitivity table otherwise looks like a constant that does not matter rather than a
field that is never read.

**Proposed amendment.** Mark the row `DERIVED` rather than `ASSUME`, or delete it and
state in prose that the white point is reported from `g_R,G,B`. Either way nobody
should plan a measurement for it: §8 items 10 and 11 already produce the gains, and the
white point falls out.

**What the code does meanwhile.** `ProjectorTransfer.whitePointK` exists because the
boundary object mirrors §3.2's table, and `photometry.ts`'s `whitePointOfTransfer`
computes the CCT from the gains instead of trusting the field — so a rig whose stored
value disagrees with its gains can be noticed rather than believed.

---

## A-28 — §10's fourth-ranked risk is inert against every §7 gate, and §10's own sentence explains why

**Status:** OPEN. Affects the §8 measurement priority, not a gate. Reported by
Experiment 3.

§10 ranks `ρ_R,G,B` fourth of its four highest photometric risks: "narrower range, but
**scales every photometric result**".

That sentence is true of the radiance field and false of the metric set. All four of
§7's photometric gates are scale-invariant by construction — the black-uplift ratio is
overlap ÷ single, the seam gate is a fraction of the local mean, and both ΔE gates
compare two points on the same surface under the same reflectance. A uniform scale
factor cancels in every one of them.

Measured: sweeping `ρ_B` across 0.78-0.95 moves the largest affected gate by **0.0004
of its threshold**, ranking reflectance **15th of the 20 constants swept**. Its range
is also `inferred` (A-04), so its position carries less evidence than the stated-range
rows above it either way.

**Proposed amendment.** Either re-rank it in §10, or — better — state what reflectance
IS load-bearing for and gate that. It sets the absolute brightness a viewer sees, which
determines the adaptation state every psychophysical threshold in §7 is quoted at, and
§7 gates nothing about absolute level at all. That is a real gap and reflectance is the
parameter that would expose it.

**What the code does meanwhile.** Reflectance is a per-channel `Scene` field with
§1's nominals, it reaches every photometric metric, and Experiment 3 reports its
near-zero sensitivity beside the reason rather than as a curiosity.

---

## A-29 — the black-uplift gates cannot be planned one constant at a time

**Status:** OPEN. Affects §8's sequencing. Reported by Experiment 3.

Sweeping each ASSUME photometric constant alone across its whole plausible range,
**no single one takes any §7 photometric gate past its threshold**; the largest
excursion is the black-uplift chromaticity shift reaching 0.82 against a gate of 2.0.

Sweeping two together does. At `L_black_G` = 1/300 and `E_amb` = 0.01 — both endpoints
of ranges PARAMETERS.md **states** — the black-uplift ratio reaches **1.125 against the
1.20 gate** and the black-uplift chromaticity shift **1.846 against 2.0**. Both come
within 8% of failing, and neither constant alone gets past 41% of its gate.

The interaction is not incidental. The three black floors compound with each other at
**1.2-1.9x** their own main effects on the chromaticity gate, because that gate depends
on the *differences* between the three floors rather than on their level — so a single
scalar black floor cannot stand in for three, and measuring one channel is nearly
useless. The black floor then compounds with ambient at about **half** the main effect,
which is A-21's structural point made numerically: the observed ratio is
`(ambient + n·floor) / (ambient + floor)`, so how visible a leak is depends on the room.

**Proposed amendment.** Describe §8 items 8, 9 and 16 as a single joint measurement
whose product is the tuple `(L_black_R, L_black_G, L_black_B, E_amb)` rather than as
three independent frames — and say explicitly that frames 8 and 9 must be read **per
channel**, not as a neutral level. §8 already calls 8 and 9 "the highest-value pair in
the list"; this entry says they are one measurement rather than two, and that item 16
belongs with them.

**What the code does meanwhile.** `metrics/photometric.ts` reports the black-uplift
ratio with ambient included as the scored metric and with ambient removed beside it,
and Experiment 3 runs the pairwise design rather than reporting main effects alone.

---

## A-30 — the coverage-margin diagnostic is misleading below N=4, in a way that reads as a number rather than as "not applicable"

**Status:** OPEN. Not a gate; a diagnostic. Reported by the interactive harness.

The harness surfaces "coverage margin at the mask edge" — how far the lit region
extends past `mask_lo` before the mask takes over. For a four-projector rig it is
a useful one-glance check.

For a **three-projector** rig it reads **−60.000°**, exactly. The cause is
arithmetic rather than physics: `coverageBoundaryLatitude` returns 0 in the dark
quadrant, and the diagnostic subtracts the 60° mask onset from it. The true
statement is "the unlit region reaches the equator in this quadrant"; what the
panel says is "the margin is −60°", which is a number a reader will reasonably
take at face value and compare against other numbers.

This is adjacent to A-10 — which records that §7's unlit-in-mask gate cannot be
met at N=2 or N=3 at all — but it is a distinct problem. A-10 is about the gate
being unsatisfiable. This is about a diagnostic that reports a *plausible-looking
finite value* where the honest output is "not applicable in this quadrant".

**Proposed amendment.** None to PARAMETERS.md. This is ours to fix: the
diagnostic should return a sentinel and render as "n/a — quadrant unlit" rather
than a subtraction against a boundary that does not exist. Recorded here rather
than fixed silently because it is the second time a plausible-looking number has
been produced where the honest answer was "no answer" — the one-camera cell in
Experiment 1 was the first, and there the 17.5 m reading was correctly labelled
degenerate rather than bad.

---

## A-31 — `k1`, `k2` and `roll` have nominals and classes but no stated range, and nothing in the register covers them

**Status:** OPEN. Low risk individually; recorded because it completes A-04's list.

A-04 enumerates the ASSUME-class constants whose plausible range PARAMETERS.md
does not state, and A-12 covers lens shift. Three parameters are on neither list
and have the same problem:

| Symbol | §3.1 nominal | Class | Range stated? |
| --- | --- | --- | --- |
| `k1` | 0 | `SOLVE` | No |
| `k2` | 0 | `SOLVE` | No |
| `roll` | 0° | `SOLVE` (§2) | No |

Being class `SOLVE` makes the *nominal* harmless — §2 is explicit that nominals
only initialise the solver. But a range is needed for two things the spec does
ask for: generating synthetic misalignment for the bench, and giving a human a
slider to drag. The harness had to invent travel for all three and marks them
`rangeSource: 'harness'` to keep them distinguishable from both stated and
inferred ranges.

`roll` deserves the specific note that §2 already gives it: "A degree of roll is
invisible on a test grid until it interacts with the blend region." That is a
statement about *why* the range matters — a plausible range for roll determines
how hard the bench's injected misalignment exercises exactly the interaction §2
flags as the dangerous one.

**Proposed amendment.** Add plausible ranges to §2 and §3.1 for `roll`, `k1` and
`k2` — ideally from the same source as A-18's recommendation, i.e. the projector's
own spec sheet and lens data, which bounds `k1`/`k2` far better than we can guess.
