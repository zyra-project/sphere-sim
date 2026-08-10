# Proposed amendments to PARAMETERS.md

PARAMETERS.md is authoritative. Nothing in this file has been applied to it, and
no constant has been silently changed anywhere in the code. Each entry records a
place where implementing the spec exposed an ambiguity, an internal tension, or
new evidence — with the reasoning, so the author can accept, reject, or refine it.

Status values: `OPEN` (awaiting a decision), `ACCEPTED` (author approved; the
edit still needs making in PARAMETERS.md), `REJECTED` (author declined; the code
keeps following the current spec text).

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
