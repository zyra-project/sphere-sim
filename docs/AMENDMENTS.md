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
