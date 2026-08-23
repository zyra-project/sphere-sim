# Experiment 2 — blend softness against geometric tolerance

**Every number in this document is PROVISIONAL.** Every photometric constant behind
it is class `ASSUME` and nobody has measured any of them (PARAMETERS.md §10,
docs/ARCHITECTURE.md's phase gate). Nothing was tuned; the sweep ran once.

- Figure: [`experiments/experiment-2.svg`](../experiments/experiment-2.svg)
- Data: [`experiments/experiment-2.json`](../experiments/experiment-2.json)
- Reproduce: `node packages/experiments/src/cli.ts 2` (about 40 s)

---

## The hypothesis, and what would have falsified it

PARAMETERS.md §7:

> **Hypothesis: proper soft blending buys geometric tolerance** — a well-blended seam
> hides misregistration that a hard or naively-ramped edge exposes. If it holds, the
> value proposition inverts from "our alignment is more accurate" to "you need less
> alignment accuracy, because the blend absorbs it."

This is the commercially interesting claim in the project, which makes it the one
most exposed to motivated reasoning. The falsifying outcomes were written into
`packages/experiments/src/photometric/experiment2.ts` before the sweep ran, and the
results file records the verdict against them mechanically:

| | Falsifying outcome | Result |
| --- | --- | --- |
| **F1** | The artifact does not fall with ramp width | **Not triggered** inside `w_width`'s 5–40° range. **Triggered** past 60°, and that is a finding in itself — see below |
| **F2** | It falls, but buys under 2× over the plausible width range | **Not triggered**: it buys **8.34×** |
| **F3** | The width that buys it pushes the binding artifact into §4.3's grazing region | **Not triggered** — and the effect runs the *other* way |
| **F4** | It falls only in a statistic that depends on the estimator's window | **Nearly triggered.** The first estimator tried did exactly this and was thrown away. See "The estimator that did not survive" |

## Verdict

**The hypothesis HOLDS in this model, over the range of `w_width` the parameter table
covers, with three qualifications that matter as much as the result.**

Doubling the blend ramp width roughly doubles the registration error the seam can
absorb, from 1.5 mm at a 5° ramp to 12.7 mm at 40°, and the relationship is a clean
inverse law in width and a clean linear law in displacement (log-log slope 1.005–1.019
across every cell). At PARAMETERS.md §4.5's nominal 20° ramp the seam tolerates
**6.2 mm** of registration error before the artifact reaches §7's 2%-of-local-mean
figure — **six times** §7's own 1.0 mm grid-displacement gate.

The three qualifications:

1. **The gain is in a quantity §7 does not gate.** §7's seam gates measure a
   *discontinuity at the hand-over*, and on this rig they cannot see any of this. The
   same 16 mm misregistration that produces a 5.2% band moves §7's shipped seam
   luminance metric from 1.37e-3 to 1.76e-3 — against a 2e-2 gate and a 2.2e-3
   estimator noise floor. So "soft blending buys tolerance" is a claim about an
   artifact the current gate set has no threshold for. This is docs/AMENDMENTS.md
   A-15 arriving from the geometric side.
2. **The benefit saturates at about 40–60° and then reverses slightly.** Past 60° the
   binding artifact moves off the equator to the ±50° seams, where the overlap is
   narrower and `cos(incidence)` at the peak is **0.32** rather than 0.95.
3. **The canonical knob is a worst case.** A realistic eleven-degree-of-freedom
   misalignment of the same p95 registration error produces **0.11–0.46×** (median
   0.23×) of the canonical artifact, because only the across-seam component of the
   *relative* displacement does anything to a blend.

---

## The contour

Registration error, in millimetres of arc between adjacent projectors at the equator,
at which the misregistration artifact reaches §7's 2% figure. Higher is more
tolerant. `w_width`'s nominal is 20°; A-04's inferred plausible range is 5–40°.

| ramp width | linear | cosine | smoothstep | gaussian | ΔE2000 = 1.0 (cosine) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5° | 1.03 | 1.53 | 1.56 | 1.58 | 3.47 |
| 8° | 1.47 | 2.45 | 2.49 | 2.56 | 5.58 |
| 12° | 1.99 | 3.70 | 3.75 | 3.89 | 8.39 |
| 16° | 2.49 | 4.95 | 5.02 | 5.27 | 11.23 |
| **20° (nominal)** | **2.97** | **6.21** | **6.30** | **6.68** | **14.10** |
| 25° | 3.54 | 7.82 | 7.92 | 8.52 | 17.71 |
| 30° | 4.15 | 9.43 | 9.54 | 10.43 | 21.37 |
| 40° | 5.76 | 12.74 | 12.85 | 14.52 | 28.79 |
| 50° | 6.92 | 16.13 | 16.23 | 14.70 | 36.40 |
| 60° | 6.92 | 18.47 | 19.38 | 13.83 | 42.89 |
| 71° | 6.92 | 18.07 | 19.02 | 13.23 | 42.00 |

**Every entry exceeds §7's 1.0 mm grid gate**, including the narrowest ramp with the
worst shape. On this evidence a rig that meets §7's geometric gate cannot produce a
visible seam through misregistration alone at any blend setting in the sweep — which
is a stronger statement than the hypothesis makes, and the one a value proposition
would actually rest on.

### The chromaticity gate never binds

The ΔE2000 = 1.0 contour sits at **2.27×** the registration error of the 2% luminance
contour, at every width. That is not a property of this rig; it is arithmetic. A
misregistration on a neutral field is a pure lightness change, and at mid-gray a 2%
luminance step is about ΔL\* 0.61, which after ΔE2000's `S_L` term at L\* ≈ 76 is
**ΔE 0.44**. So the luminance gate trips first, always.

PARAMETERS.md §7 says of the chromaticity gate: *"The eye is more sensitive to
chromatic edges than luminance ones, so this gate should be at least as tight as the
luminance gate, not looser."* For this artifact **it is 2.3× looser**, because
ΔE2000 includes ΔL\* and the two gates are therefore not independent. → proposed
**A-24**.

### Shape matters, but an eighth as much as width

At the nominal 20° width and 16 mm of error:

| shape | artifact | artifact FWHM |
| --- | ---: | ---: |
| linear | 7.89% | 4.5° |
| cosine | 5.21% | 12.0° |
| smoothstep | 5.14% | 12.25° |
| gaussian | 4.83% | 12.75° |

§4.5 calls the ramp shape unpublished and it is the only blend parameter with four
candidate values. It is worth **1.63×** between the best and worst choice, against
**8.3×** for the width over its plausible range. The linear ramp is the outlier and
its FWHM says why: with `γ_blend` = 0.8 applied to the weight, a linear ramp has a
slope discontinuity where it meets the clamped plateau, so its artifact is
concentrated into 4.5° instead of spread over 12°.

**If only one thing about the blend can be measured on the visit, measure the width.**

### `γ_blend` is nearly inert, as conventions.ts §B predicts

Swept over 0.5, 0.8, 1.0, 1.5 at the nominal width, 16 mm of error: 7.54%, 5.21%,
5.23%, 5.67%. §B applies the exponent to the *weight* and then normalizes, so it
cannot create or remove a luminance step; what it does is reshape the crossfade, and
0.8–1.0 is flatly the best part of the range. §4.5's DOC-class 0.8 is a good value for
this rig, which is a mild independent corroboration of the config it came from.

---

## Where the artifact actually is, and why §7 cannot see it

This is the structural result and it drove every methodological choice below.

`coverage.ts` anchors each projector's blend ramp at **its own footprint edge** — the
sphere's limb as seen from that lens — and ramps inward over `w_width`. At the equator
two adjacent projectors overlap over 70.8° of longitude. At the nominal 20° width
their raw weights are therefore both clamped at 1 across a **31°-wide plateau** in the
middle of that overlap, normalized to 0.5/0.5.

§7's hand-over — the longitude where the two normalized weights are equal — is in the
middle of that plateau. The weight gradient there is exactly zero. **Displacing a
constant produces a constant**, so no misregistration of any size can create a step at
the point the gate measures. The artifact lives in the two ramp bands 15–25° either
side, entirely outside the estimator's ±6° window.

Measured, cosine ramp at the nominal width:

| registration error | §7 seam luminance (gate 0.02) | §7 estimator's own floor | this experiment's reading |
| ---: | ---: | ---: | ---: |
| 0 mm | 1.37e-3 | 2.22e-3 | 0 by construction |
| 4 mm | 1.47e-3 | 2.57e-3 | **1.28%** |
| 16 mm | 1.76e-3 | 2.22e-3 | **5.21%** |
| 64 mm | — | — | **21.7%** |

At 16 mm the §7 gate reading is *below its own control*. The honest statement about
that rig is not "the seam is 0.18%" but "the §7 estimator cannot resolve anything
here", and the field nonetheless carries a 5.2% band 12° wide.

## The estimator that did not survive, and why it is in the repo anyway

The obvious repair is to slide §7's own estimator along the whole overlap and take the
worst window. It produces a beautiful result — 14.3% at a 10° ramp falling to 0.41% at
71° — and **it is not a measurement.** On a *perfectly registered* rig:

| ramp width | guard 1, window 3, degree 3 | **guard 2, window 6, degree 3 (§7's own)** | guard 4, window 12, degree 5 |
| ---: | ---: | ---: | ---: |
| 10° | 3.1% | **14.3%** | 56.0% |
| 20° | 0.7% | **2.6%** | 14.2% |
| 40° | 0.2% | **0.6%** | 3.8% |

A factor of eighteen between the narrowest and widest window, with nothing to measure.
That is the signature of an estimator reading *curvature* rather than a step: the
departure of a smooth function from a degree-`d` fit over a window `W` scales as
`W^(d+1)`. §7's window was chosen — and validated by its control — for a locally
smooth field with a possible step in it. The ramp band is neither.

So the reading was demoted from the finding to a documented negative result.
`estimatorScan` stays in `artifact.ts`, the three window sizes are recomputed in every
baseline of the results file, and `test/artifact.test.ts` asserts the spread is still
large. A rejection nobody can reproduce is a rejection that gets re-litigated.

**A second estimator was rejected earlier and more quietly:** differencing the
misregistered rig against the *nominal* rig. Those are two different physical rigs, so
the difference contains the change in incidence and distance from having moved the
lenses — about 1.4% at the ramp band before any blend error at all. It reports a floor
that is not an artifact.

### What the experiment measures instead

**One physical rig, rendered twice**: once with the content calibration it actually
has, once with the compositor holding the truth. Same lenses, same incidence, same
falloff, same transfer, same shading — the only difference is what the software
believed, which is the definition of a registration error. It is exactly zero when the
two calibrations agree (asserted at every shape and width), and it needs no window, no
polynomial and no choice of scale.

It is a differential between two simulations and no photograph can produce it. That
puts it in the same class as `metrics/photometric.ts`'s divergence readings, and it
gets the same treatment: **reported, never scored**, quoted beside §7's gate for scale
rather than against it.

**A band of 2% and a step of 2% are the same number and not the same thing to an eye.**
The experiment reports the artifact's full width at half maximum beside its amplitude
(4.5°–22.5° across the sweep) precisely so a reader can see that the comparison to
§7's step gate is a scale and not a verdict. Setting a real threshold for a band needs
the §8 visit — A-15's point exactly.

---

## The grazing-incidence check, which came out backwards

The concern was that a ramp wide enough to hide misregistration would push the seam
into the region §4.3 already calls degenerate. **It does the opposite**, and the reason
is the anchoring: the ramp starts at each projector's own footprint edge, which *is*
the limb.

| ramp width | area whose delivered light is below §4.3's cos 0.2 | mean incidence lost to the blend | steepest hand-over |
| ---: | ---: | ---: | ---: |
| 5° | 5.41% | 0.046 | 19.5%/° |
| 20° | 5.10% | 0.036 | 5.07%/° |
| 40° | 5.05% | 0.023 | 3.26%/° |
| 71° | 5.05% | 0.016 | 3.19%/° |
| *floor (best projector, blend-independent)* | *4.76%* | — | — |

A **narrow** ramp is the one that hands a projector its full share within a couple of
degrees of its own limb, where its cosine is near zero. Widening moves the crossfade
inward toward better incidence on both counts. The blend-attributable smear falls from
0.65 to 0.29 percentage points of the sphere, and the mean incidence the blend spends
falls by a factor of three.

Where the concern *is* real is past 60°: the binding artifact moves from the equator
(cos 0.95) to the ±50° seams (**cos 0.32**). That is the mechanism behind F1 triggering
on the full sweep, and it is why the verdict is stated over 5–40° and the tail is
reported rather than folded in.

**On the domain split, stated plainly.** F1 as written — "the artifact does not fall
with ramp width" — is failed by the ≥50° tail and passed over 5–40°. The verdict rests
on 5–40° because that is the range `parameters.ts` gives `w_width`; the wider settings
were added to find where the mechanism runs out, and judging a hypothesis on
configurations the spec does not describe would be judging something else. Both
booleans are in the results file (`fallsWithWidth`, `fallsWithWidthFullSweep`) and
`saturationWidthDeg` names where they diverge, so a reader who wants the other split
can take it. Note that 5–40° is itself an *inferred* range (A-04) — the spec states no
range for `w_width` at all.

## The blend's own cost, which is larger than the misregistration's

At perfect registration the delivered luminance falls by about **43% across one
overlap**, because the blend is handing light from a projector that is nearly head-on
to one that is at its own limb. No blend setting removes that — it is §4.1's incidence
falloff, and the sphere is genuinely dimmer in its seams. What the ramp width sets is
how *abruptly*: 19.5% per degree of arc at a 5° ramp against 3.2%/° at 40°, where it
has reached the underlying geometric gradient and stops improving.

That is the same 6× the tolerance contour shows, arrived at without any misregistration
at all, and it is the strongest argument in this experiment for a wide blend. It is
reported as a gradient rather than as a percentage precisely because a percentage would
need a window.

## Does the canonical knob generalise?

The sweep moves one thing: a rigid rotation of each projector about the polar axis,
alternating in sign, which displaces every texel by `R·ε·cos(lat)` purely across the
seam. `test/misregistration.test.ts` checks that against `packages/sim`'s own geodesic
measurement of where two projectors land the same texel — a different route through the
frustum, the distortion model and a ray-sphere intersection — and the two agree to
within 1%.

Nine seeded rigs from `sim/scene.ts`'s own `injectMisalignment`, at three magnitudes
and three widths, measured the same way:

| statistic | realistic ÷ canonical |
| --- | ---: |
| against the canonical curve at the rig's **p95** registration error | 0.11 – 0.46 (median 0.23) |
| against the canonical curve at its **max** | 0.02 – 0.21 (median 0.08) |

So the contour is **conservative by roughly 2–10×** against a realistic misalignment of
the same measured registration error. Only the across-seam component of the *relative*
displacement between two neighbours does anything to a blend; a displacement along the
seam line, or a common displacement of both projectors, is invisible to it.

One number from that cross-check is worth stating on its own: at
`DEFAULT_MISALIGNMENT` itself, an *uncalibrated* nominal-versus-actual rig carries
**90–350 mm** of registration error. That is one to two orders of magnitude past
anything a blend absorbs. **The blend buys tolerance around a solved calibration; it
does not replace one.**

---

## What this means for the value proposition

The honest version of the inverted claim is narrower than §7's phrasing and stronger
where it is narrow:

> A 20° cosine blend absorbs about 6 mm of residual registration error before the seam
> reaches §7's 2% figure, and 40° absorbs about 13 mm. §7's own alignment gate is
> 1.0 mm. So on this model **the seam is not what limits alignment tolerance** — at any
> blend setting in the plausible range, the geometry gate binds first by a factor of
> six or more. Widening the blend buys tolerance linearly until about 40°, after which
> it buys smoothness and nothing else.

Three things must travel with that sentence or it is an advertisement:

1. It is PROVISIONAL. Every photometric constant under it is unmeasured.
2. The metric it is stated in has no gate in §7, and the gate §7 does state cannot see
   the artifact at all.
3. It is measured against a *residual* registration error, i.e. what is left after the
   alignment solve. An unsolved rig is 100× outside it.

## Proposed amendments

- **A-24 — §7's two seam gates are not independent, and the chromatic one is the
  looser.** ΔE2000 includes ΔL\*, so a pure luminance artifact registers on both. For a
  misregistration on a neutral field the ΔE 1.0 gate corresponds to a 4.5% luminance
  step, 2.3× the luminance gate's own 2%. §7's stated intent — "at least as tight as
  the luminance gate, not looser" — is not met by the pair as written. Either state
  the chromaticity gate on a chroma-only difference (ΔE with ΔL\* removed, or ΔE_ab in
  a\*b\* alone), or tighten it to about 0.44 so the two bind together.
- **A-25 — §4.5 states the blend's width and shape but not its ANCHOR, and the anchor
  decides where the artifact is.** `coverage.ts` ramps inward from each projector's
  footprint edge, which puts the whole crossfade in the region §4.3 calls degenerate
  and puts a 31° zero-gradient plateau exactly where §7 measures. A blend anchored on
  the seam bisector instead would put the crossfade where both projectors have equal
  incidence and would put a gradient under §7's estimator. Both readings are consistent
  with §4.5 as written. Add one clause naming which, and add the blend-region geometry
  to §8 item 13's read.
- **A-26 — the ramp width is worth 8× and the ramp shape 1.6×.** §8 item 13 asks for
  `w(θ)` shape and `w_width` from one photograph. If the frame is imperfect, the width
  is the number to get right; the shape can be inferred later from the same frame or
  left at cosine with a 1.6× penalty at worst.

## Reproducing

```
node packages/experiments/src/cli.ts 2      # 40 s, writes experiments/experiment-2.{json,svg}
node --test "packages/experiments/test/*.test.ts"
```

`experiments/experiment-2.json` carries every cell (4 shapes × 11 widths × 8
registration errors), the per-width baselines including the three-window estimator
spread, the `γ_blend` sweep, the realistic cross-check, and the verdict object the
falsification criteria were evaluated into.
