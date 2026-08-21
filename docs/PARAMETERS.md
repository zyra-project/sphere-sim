# sphere-sim — Physical Parameter Set

Rev 2. Supersedes rev 1. Changes: photometric terms split per-channel, blend
ramp modeled explicitly, coverage and overlap treated as fields over the sphere
rather than constants, polar masking added, chromaticity gate added, capture
checklist expanded.

Reference for every physical constant the simulator depends on, where it comes
from, and how much it can be trusted.

The purpose of this document is to make the simulator's assumptions **auditable**.
A simulator used as a quality bar is only as honest as its inputs. Any parameter
classed `ASSUME` below is a place where the bar could be confidently wrong.

---

## How to read this

| Class | Meaning | Risk if wrong |
| --- | --- | --- |
| `DOC` | Published in NOAA SOS documentation or config | Low — but check the citation |
| `CFG` | Read from a hardware spec sheet or site config | Low — known per install |
| `SOLVE` | Recovered by the alignment bundle adjustment | **None** — nominal is only an initialization |
| `ASSUME` | Not published, not yet measured, chosen by us | **High** — this is where the bar breaks |
| `MEAS` | Pending measurement at a real installation | Blocking for photometric metrics |

**The central conclusion, stated up front:** every *geometric* parameter is
`DOC`, `CFG`, or `SOLVE`. Every *photometric* parameter is `ASSUME` or `MEAS`,
and rev 2 has tripled their count by splitting them per channel. Geometric
metrics (grid displacement, pose recovery, registration error) are trustworthy
today. Photometric and chromatic metrics (seam luminance, seam color, black
uplift) are **not trustworthy until the ground-truth visit happens**. Sequence
the work accordingly: gauntlet the alignment solver now, hold the blend work.

---

## Conventions

**Units.** SI throughout. NOAA's documentation is imperial; conversions are given
explicitly so nobody re-derives them under pressure.

**World frame.** Right-handed. Origin at sphere center. `+Z` up, `+X` toward the
canonical prime meridian, `+Y` completing the triad. Floor at `z = -h_center`.

**Sphere frame.** Latitude `λ`, longitude `ψ`. `(0°N, 0°E)` on the `+X` axis,
matching SOS's requirement that source imagery is centered on the prime meridian.

**Radiometry.** Relative linear radiance, per channel. Define `1.0` = a single
projector's full-output value in that channel at the center of its own footprint,
measured at the sphere surface. Ambient, black floor, and multi-projector sums
are fractions of that. All blending, summation, and metric computation happen in
linear light; encode only at the final viewer-camera step.

**Color.** Work in linear RGB for summation, convert to CIE XYZ → Lab for the
chromaticity metric. Channel-independent transfer functions — this is the central
change in rev 2 and it is not optional.

---

## 1. Sphere geometry

| Symbol | Parameter | Nominal | Class | Source / note |
| --- | --- | --- | --- | --- |
| `D_sphere` | Sphere diameter | 1.7272 m (68 in) | `DOC` | Standard carbon-fiber sphere. Other sizes exist. Keep configurable. |
| `R` | Sphere radius | 0.8636 m | `DOC` | Derived. |
| `h_bottom` | Floor to sphere bottom | 1.3208 m (52 in) | `DOC` | |
| `h_center` | Floor to sphere center | 2.1844 m (86 in = 7 ft 2 in) | `DOC` / `SOLVE` | Equals equator height. See note. |
| `ρ_R, ρ_G, ρ_B` | Diffuse reflectance per channel | 0.90, 0.90, 0.88 | `ASSUME` | Matte white paint. Slight blue falloff assumed; white paints commonly are not spectrally flat. Unpublished. |
| `ρ_spec` | Specular lobe weight | 0.03 | `ASSUME` | Matte paint still has a low-gloss lobe, producing a hot spot toward each projector. Set to 0 to test sensitivity. |
| `α_spec` | Specular roughness | 0.4 (GGX) | `ASSUME` | Broad, dim lobe. Pure guess. |
| `θ_rot` | Sphere rotation vs. canonical prime meridian | 0° | `CFG` | Sites rotate the sphere mechanically. Modeled in terraviz PR #205 as `rotationOffsetDeg`. |
| `occl_top` | Suspension hardware occlusion | 6° polar cap | `ASSUME` | The sphere hangs from a mount, physically obstructing the north polar cap. **See §4 — this is why SOS masks only the bottom.** |

### Note on `h_center` — why it is `SOLVE`, not `MEAS`

NOAA's alignment tips say that when vertical grid lines diverge or crisscross in
the overlap regions near the poles, the usual cause is a mis-measured
ground-to-sphere-center distance, and the recommended remedy is to add or
subtract an inch in the config and re-run alignment.

A tape measure feeding an inch-sensitive system with a trial-and-error correction
loop. Our bundle adjustment treats `h_center` as a free parameter with the
documented value as initialization. Recovering it to sub-centimeter accuracy from
camera views is a concrete improvement over the existing procedure and is worth
calling out separately in the invention disclosure.

---

## 2. Projector placement (per projector, ×4)

All six pose DOF are `SOLVE`. Nominals exist to initialize the solver and to
generate synthetic test cases.

| Symbol | Parameter | Nominal | Class | Source / note |
| --- | --- | --- | --- | --- |
| `d_proj` | Distance, sphere center to lens | **5.18–6.14 m — conflicted, see below** | `SOLVE` | |
| `φ_i` | Azimuth of projector *i* | 0°, 90°, 180°, 270° | `SOLVE` | Counterclockwise from P1 (nearest the SOS computer). Real mounts hold ±1–2°. |
| `h_proj` | Projector height above floor | 2.1844 m | `SOLVE` | Documentation states projectors are "generally" at the same 7 ft 2 in as the equator. |
| `yaw, pitch` | Aim direction | at sphere center | `SOLVE` | |
| `roll` | Rotation about optical axis | 0° | `SOLVE` | A degree of roll is invisible on a test grid until it interacts with the blend region. |
| `N_proj` | Projector count | 4 | `CFG` | 2- and 3-projector installs are supported; quadrants go dark. Simulator must handle N=2,3,4. |

### The `d_proj` conflict — unresolved

- The **alignment manual** puts projectors about 17 ft (5.18 m) from sphere center.
- The **floor plan** gives a square 25.5–28.5 ft on a side with `side = √2 × D`,
  yielding D = 18.0–20.2 ft (5.50–6.14 m).

These do not overlap. Different reference point, rounding, or newer lenses — the
documentation doesn't say. Treat `d_proj` as `SOLVE` with a wide prior
(5.0–6.5 m); settle it with a tape measure on the ground-truth visit.

**This parameter drives §4's coverage arithmetic**, so absolute coverage figures
below carry its uncertainty. The *shape* of the coverage field does not change.

---

## 3. Projector optics and transfer (per projector, ×4)

### 3.1 Geometry and framebuffer

| Symbol | Parameter | Nominal | Class | Source / note |
| --- | --- | --- | --- | --- |
| `res_proj` | Native resolution **per projector** | 1920×1080 or 3840×2160 | `CFG` | **See §3.4 — SOS drives all four from one framebuffer, so the X screen is 2× this in each dimension.** |
| `PAR` | Pixel aspect ratio | 1.0 | `DOC` | Content guidelines require square pixels. |
| `T` | Throw ratio | ≈ 3.0 : 1 | `CFG` | Derived: image width ≈ sphere diameter at `d_proj`. Long-throw lens. |
| `fov_h` | Horizontal field of view | ≈ 18.9° | `SOLVE` | Derived from `T`. |
| `shift_v`, `shift_h` | Lens shift | 0 | `SOLVE` | Non-zero for ceiling mounts. |
| `k1, k2` | Radial distortion | 0, 0 | `SOLVE` | **This is what SOS's manual "Vertex Tweaking" stage compensates by hand.** Solving it is what collapses their three stages into one. |
| `p1, p2` | Tangential distortion | 0, 0 | `ASSUME` | Hold at zero unless residuals demand otherwise. Extra DOF overfits. |

### 3.2 Per-channel transfer — the rev 2 change

Rev 1 modeled gamma and black floor as scalars. That was wrong, and it made the
simulator structurally incapable of reproducing the most visible real-world seam
artifact: **a colored band rather than a bright or dark one.**

| Symbol | Parameter | Nominal | Class | Note |
| --- | --- | --- | --- | --- |
| `γ_R, γ_G, γ_B` | Transfer exponent per channel | 2.2, 2.2, 2.2 | `ASSUME` / `MEAS` | Real projectors diverge 0.1–0.3 between channels. **12 values across the rig.** |
| `L_black_R,G,B` | Black floor per channel, fraction of full output | 1/800 each | `ASSUME` / `MEAS` | DLP and LCD leak differently per channel; the uplift in overlaps is *tinted*, usually blue-gray. Plausible range 1/2000–1/300. **12 values.** |
| `g_R, g_G, g_B` | Channel gain | 1, 1, 1 | `ASSUME` / `MEAS` | Lamp aging diverges between projectors. Four lamps at different hour counts give four different white points. **12 values.** |
| `wp_i` | White point (CCT) | 6500 K | `ASSUME` | Derived from `g`; tracked separately for reporting. |

**Why this matters, worked.** In an overlap each projector should contribute 0.5
linear, encoded as `0.5^(1/γ)` = 0.730 at γ=2.2. If that projector's blue channel
runs γ=2.4, blue emits `0.730^2.4` = 0.469 per projector, summing to 0.938 against
1.000 in red — a 6% blue deficit. The just-noticeable threshold for a luminance
step is 1–2%, and the eye is *more* sensitive to a chromatic edge than a
luminance one. The seam reads as a yellow band. No scalar gamma can correct this.

### 3.3 Depth of field

`ASSUME`, not modeled in v1, documented as a known omission in §9. The depth
swing across one footprint is ~0.79 m (`d_proj − R` = 4.32 m at the near point vs
`√(d_proj² − R²)` = 5.11 m at the tangent circle). Focus is worst exactly where
the blend regions sit, so a passing seam score in simulation may overstate reality.

### 3.4 Framebuffer topology — from the SOS config

The SOS operations config specifies:

```
set projectorInfo(viewport) { 0,0,0.5,0.5  0.5,0,0.5,0.5  0,0.5,0.5,0.5  0.5,0.5,0.5,0.5 }
set projectorInfo(hostname) { localhost localhost localhost localhost }
set numberOfProjectors 4
set env(SOS_DISPLAY) :1
```

Four normalized quadrant viewports, all `localhost`, one X display. **This is a
single framebuffer split 2×2, not four independent outputs.** Two T1000s spanned
into one X screen.

Two consequences:

1. **Per-projector resolution is half the X screen in each dimension.** Four
   native-4K projectors require a 7680×4320 X screen. Any resolution figure must
   state which it means.
2. **The simulator's output primitive should be one framebuffer with four
   viewports**, matching the deployment target. This also means the multi-window
   IPC architecture in terraviz PR #205 — state aggregator, playback drift
   correction, per-output crash recovery — is the wrong shape for projected SOS.
   Drift is zero by construction when there is one decoder and one swap. That
   architecture remains correct for LED spheres and presenter modes.

---

## 4. Coverage, overlap, blending, and masking

This section is new in rev 2 and it is where the interesting physics lives.

### 4.1 Coverage is a field, not a constant

For a point at angular distance `θ` from a projector's sub-projector point, with
projector at distance `d` and sphere radius `R`:

```
cos(incidence) = (d·cos θ − R) / √(d² − 2dR·cos θ + R²)
```

This equals 1 at `θ`=0 and falls to 0 at `cos θ = R/d`, i.e. `θ_max` =
`acos(R/d)` = **80.4°** at d=5.18 m. Beyond that the surface is behind the limb
and receives nothing.

A point at `(λ, ψ)` is illuminated by projector `i` at azimuth `φ_i` when
`cos λ · cos(ψ − φ_i) > R/d`.

### 4.2 Overlap multiplicity never exceeds 2 — correcting a rev 1 error

Rev 1 asserted that overlap goes 2-way → 3-way → 4-way toward the poles. **That
is wrong.** Working it out: three-way overlap would require a point within 80.4°
of three equatorial directions spaced 90° apart. Two of any three such directions
are antipodal in azimuth, so the only candidate region is near a pole — and the
poles sit exactly 90° from every projector, outside the 80.4° limit.

So **N is 1 or 2 everywhere**: 1 near each projector's center meridian, 2 in the
seams. This is a consequence of the Red Ball alignment procedure, which
constrains each projector's content to the sphere's silhouette from its own
position.

### 4.3 There is a permanently unlit polar region, and it is scalloped

Coverage reaches `λ` = 80.4° along a projector's own meridian but only 76.3° in
the seam directions (`cos λ · cos 45° = R/d`). The unlit region is therefore
**not a circular cap — it is a four-lobed scalloped shape**, dipping lowest
between projectors. Roughly 1.4–2.8% of the sphere by area, per pole.

The *practically* unusable region is much larger. Taking `cos(incidence)` < 0.2
as the point where resolution smear exceeds 5× and the image becomes streaks:

| Direction | Usable to latitude |
| --- | --- |
| Along a projector meridian | ≈ 69° |
| In a seam direction | ≈ 59° |

### 4.4 The bottom mask, explained

The SOS config specifies:

```
set bottommask 60,70
```

Read as an onset and a full-mask latitude (`ASSUME` — verify), **60° matches the
seam-direction usable limit of ≈59° computed above almost exactly**, with a 10°
feather to full mask. That is a strong indication the mask exists to hide the
degenerate grazing-incidence region, not to suppress overlap brightness — §4.2
shows there is no 4× pile-up to suppress.

**Why bottom only.** The sphere hangs from a ceiling mount, which physically
occludes the north polar cap. The bottom pole is exposed and visible from below,
so it needs a software mask. The asymmetry in the config is explained by the
hardware.

The simulator must model the mask, or seam metrics will report failures in a
region nobody projects onto.

### 4.5 Blend ramp

| Symbol | Parameter | Nominal | Class | Note |
| --- | --- | --- | --- | --- |
| `w(θ)` | Blend weight function | cosine ramp | `ASSUME` | Shape unpublished. |
| `γ_blend` | Blend ramp exponent | **0.8** | `DOC` | From the SOS config, comment reads: default gamma setting for projectors to facilitate edge blending. **One global scalar for four projectors and three channels.** |
| `w_width` | Blend region angular width | ~20° | `ASSUME` | Derived from seam geometry; verify against a real sphere. |
| `mask_lo, mask_hi` | Polar mask onset / full | 60°, 70° | `DOC` | Units inferred as latitude. Verify. |

**On the value 0.8, and a correction to my earlier reading.** For two projectors
to sum to unity in the overlap, each must emit 0.5 linear, encoded as
`0.5^(1/γ)`. An exponent of 0.8 implies an effective display transfer of γ≈1.25.

I previously suggested ambient light explains the low figure. **The arithmetic
does not support that.** Including an additive floor `f`, continuity requires
`V^γ = (1−2f)/(2(1−f))`; at γ=2.2 and a generous f=0.05 this gives V=0.716
against 0.730 with no floor at all. A 2% shift. Ambient is not the explanation.

Two better readings: the projectors run a flat high-brightness transfer near
γ≈1.25 (bright/presentation modes commonly crush the curve to 1.6–1.8, and lower
is possible), or 0.8 is an empirical shaping constant tuned until the band
disappeared rather than a derived inverse gamma. Either way the conclusion holds —
it is one global number standing in for something that varies per projector and
per channel, and it cannot correct a chromatic seam.

---

## 5. Room environment

| Symbol | Parameter | Nominal | Class | Note |
| --- | --- | --- | --- | --- |
| `E_amb` | Ambient luminance on sphere, relative | 0.04 | `ASSUME` / `MEAS` | NOAA's automated-alignment docs note ambient and direct light throw off their CV, and that they have unusually good lighting control at their own facility — implying typical sites do not. Range 0.01–0.15. |
| `E_amb_chroma` | Ambient color temperature | 4000 K | `ASSUME` | Exhibit lighting is rarely daylight-balanced. Tints the whole sphere and shifts every ΔE measurement. |
| `amb_dir` | Ambient directionality | uniform hemisphere | `ASSUME` | Real rooms have windows, spots, exit signs. |
| `ρ_room` | Wall/floor albedo | 0.3 | `ASSUME` | Reaches a geometric result directly: with `roomSpill` on it scales every off-sphere return before the decoder's modulation gate, so it sets how much contamination experiments 4 and 5 see. The earlier note here said it only mattered via inter-reflection; that stopped being true when the room became switchable. |
| `r_wall` | Distance from the sphere's vertical axis to the wall | 6.0 m | `ASSUME` | The room the structured-light pattern lands on when `roomSpill` is enabled. Nobody has measured a building; 6.0 m is a gallery-sized guess and experiment 4 swept 4, 6 and 9 m around it without being able to order them. Had no row in this document until the room became switchable — it lived only as a literal in `packages/bench/src/capture.ts`. |
| `h_ceiling` | Floor to ceiling | 4.27 m | `ASSUME` | 14 feet. Same provenance as `r_wall`: a guess, and the surface that matters most, because the ceiling and the floor are NEARER their projectors than the sphere is and therefore come back at least as bright — which is why no decoder brightness threshold separates them from the ball. |

---

## 6. Viewer

| Symbol | Parameter | Nominal | Class | Note |
| --- | --- | --- | --- | --- |
| `h_eye` | Eye height | 1.60 m (adult) / 1.15 m (child) | `ASSUME` | **Run both.** The equator sits at 2.18 m, so everyone looks up; children steeply. Children are a large share of the SOS audience. |
| `d_view` | Viewing distance from sphere center | 2.0–3.5 m | `CFG` | Bounded below by the guard rail. |
| `fov_eye` | Camera FOV for rendered views | 50° | `ASSUME` | Framing choice. Metric values must not depend on it. |

A viewer at 2.5 m sees a cap bounded by `acos(R/d_view)` ≈ 69.7° from the
sub-viewer point — about 140° of longitude, roughly a third of the surface.
Legibility metrics compute over the visible cap, not the full sphere.

---

## 7. Metric acceptance thresholds

**NOAA publishes no numeric alignment tolerance** — the documented standard is
that an experienced operator judges the image continuous. These gates come from
psychophysics and are the softest quantitative claims here.

| Metric | Gate | Class | Basis |
| --- | --- | --- | --- |
| Grid-line displacement across a blend region | ≤ 1.0 mm on sphere surface | `ASSUME` | ~1 arcmin at 2.5 m. |
| Seam luminance discontinuity | ≤ 2% of local mean | `ASSUME` | Weber fraction for a step in a smooth field. |
| **Seam chromaticity discontinuity** | **ΔE2000 ≤ 1.0** | `ASSUME` | **New in rev 2.** Conservative — ΔE 1.0 is the classic just-noticeable difference under ideal conditions. The eye is more sensitive to chromatic edges than luminance ones, so this gate should be at least as tight as the luminance gate, not looser. |
| Black uplift ratio, overlap ÷ single | ≤ 1.20 | `ASSUME` | Below where an overlap band reads as a visible rectangle in dark content. |
| **Black uplift chromaticity shift** | **ΔE2000 ≤ 2.0** | `ASSUME` | **New.** Looser than the highlight gate because it applies in dark content where chromatic discrimination is poorer. |
| Pose recovery error (synthetic ground truth) | ≤ 2 mm position, ≤ 0.05° rotation | — | Chosen so geometric error is dominated by other terms. |
| Off-sphere flux (Red Ball equivalent) | ≤ 52% | `ASSUME` | Floor is ~51% from raster geometry. Catches gross misaim. |
| Unlit fraction *within the mask boundary* | 0% | — | Hard requirement. Computed inside `mask_lo`, not over the full sphere. |

### The metric worth building first

Sweep geometric registration error against blend softness and find where the seam
becomes visible. **Hypothesis: proper soft blending buys geometric tolerance** —
a well-blended seam hides misregistration that a hard or naively-ramped edge
exposes. If it holds, the value proposition inverts from "our alignment is more
accurate" to "you need less alignment accuracy, because the blend absorbs it."
That is a better story, and unlike the accuracy claim it is testable entirely in
simulation before anyone visits a sphere.

---

## 8. Ground-truth measurement checklist

The photometric half of this document stays fiction until these are collected.
Roughly 30–40 minutes with a tethered camera. **Camera on full manual throughout:
fixed ISO, aperture, shutter, white balance. RAW only. Do not let anything
auto-adjust between frames or the whole set is unusable.**

**Geometry (5 frames + measurements)**
1. Tape measure: floor to sphere center; floor to each projector lens; sphere
   center to each projector lens. Settles the `d_proj` conflict.
2. Projector make and model → throw ratio, native resolution, lens shift range.
3. X screen resolution from the SOS machine — confirms §3.4.
4. Grid alignment pattern, photographed from a marked, measured position.
5. Read the site's actual config: `gamma`, `bottommask`, `viewport` values as
   deployed, which may differ from the documented defaults.

**Neutral photometry (7 frames)**
6. Full white, each projector alone — 4 frames. Per-projector falloff and gain.
7. Full white, all projectors — 1 frame. The overlap sum.
8. Full black, projectors **on** — 1 frame. → `L_black`
9. Full black, projectors **off** — 1 frame. → `E_amb`

Frames 8 and 9 are the highest-value pair in the list: their difference is the
black-floor term that drives every overlap artifact, and no published
documentation gives it.

**Per-channel photometry (18 frames) — new in rev 2**
10. Full red, full green, full blue, each projector alone — 12 frames.
    → `g_R,G,B` per projector, and per-channel falloff.
11. Full red, full green, full blue, all projectors — 3 frames.
    → the chromatic overlap sum, which is the artifact under investigation.
12. Step wedge in each channel separately, one projector — 3 frames.
    → `γ_R, γ_G, γ_B`. Repeat on a second projector if time allows; divergence
    between two projectors tells you whether per-projector solving is needed.

**Blend characterization (3 frames)**
13. Flat mid-gray field, all projectors, in the darkest room condition available.
    The seams should be at their most visible. → `w(θ)` shape and `w_width`.
14. Same, in normal operating room light. → how much ambient masks the seam.
15. Flat mid-gray with the polar region included → verifies `bottommask` behavior
    and units.

**Environment (2 readings)**
16. Lux meter at the sphere surface, normal operating light and house lights up.
17. Note lamp hours per projector if the site tracks them — directly predicts
    `g` divergence.

**The room the pattern lands on (2 frames + measurements) — new in rev 3**

Everything above characterises the sphere. These characterise everything else in
the throw, and they are here because experiment 4 measured what omitting them
costs: with a room behind the ball, 14% of accepted correspondences come back
from surfaces that are not the sphere, and the recovered pose degrades by a
paired factor of 146. Experiment 5 then measured the mitigation — segmenting the
sphere out of the photograph recovers it, 2 usable solves in 30 becoming 28.

Neither can be turned on for a published number until these are collected. The
size of the effect is set by `ρ_room`, which is `ASSUME` at 0.3 with nobody
having measured a wall, so switching the room on today would make every geometric
result depend on a guess — which is the thing §10's sequencing exists to prevent.

18. Grey card (or any known-reflectance reference) held flat against the wall and
    against the floor inside a projector's throw, one frame with that projector
    showing full white, at the same exposure as frame 6. → `ρ_room`, and whether
    wall and floor differ enough to need separate values. **This is the
    highest-value item added in rev 3**: it is the one number standing between a
    measured room and an assumed one.
19. Tape measure: sphere's vertical axis to the nearest wall, and floor to
    ceiling. → `r_wall`, `h_ceiling`, both currently `ASSUME`. Note anything else
    inside the throw that the model does not have — a guard rail, a plinth, a
    door, a case — because §9 records that the simulator has no occlusion at all,
    so those surfaces are the difference between a floor on the effect and a
    bound on it.
20. One frame of a projector's spill on the room with the sphere absent from the
    frame, if the geometry allows it. → a direct check on the falloff the model
    assumes, rather than an inference from the sphere.

Total ≈ 37 frames. A tethered camera and a scripted pattern sequence makes this
one continuous run rather than 37 manual setups.

---

## 9. What this simulator does not model

- Inter-reflection between sphere, walls, and floor. The light reaches the room
  and stops: it never comes back onto the ball. Note the asymmetry this leaves —
  the model has the half of room coupling that ADDS false correspondences and not
  the half that would degrade good ones, and nothing measures which way that
  biases the segmentation results in experiment 5.
- Projector depth-of-field and focus falloff across the ~0.79 m depth swing
- Chromatic aberration
- Lamp warm-up drift and long-term aging (gain divergence is modeled statically)
- Screen-door / pixel-fill-factor structure
- Air scattering (visible beams in dusty or humid rooms)
- Viewer stereopsis on a curved surface
- Spectral rendering — RGB only, so metamerism between projector primaries and
  ambient light is approximated, not simulated
- The guard rail and its shadow. More generally there is NO occlusion anywhere:
  nothing in the model blocks a beam or casts a shadow, so a rail, a plinth, a
  door or a visitor is absent from every capture. This is the reason experiment
  4's room is a floor on the effect rather than a bound on it, and the reason
  experiment 5's silhouette detector — which assumes the ball is framed and the
  room runs off the frame edge — has not been tested against the thing most
  likely to break it.

**One thing this list used to imply and no longer should.** The pattern landing
on the room IS modelled, as of the `roomSpill` capture condition: the first
bounce onto a cylindrical wall, a floor and a ceiling. It is **off by default**,
every number this document and `bench-results.json` carry was produced with it
off, and §8 items 18–20 exist to collect what would let it be switched on
honestly. What remains unmodelled is the SECOND bounce, above.

The first two matter most. Focus falloff degrades exactly the blend regions the
metrics care about, so a passing seam score may overstate real-world quality.

---

## 10. Provenance summary

| Class | Count | Where the risk sits |
| --- | --- | --- |
| `DOC` | 11 | Low. `d_proj` conflicts; `gamma 0.8` and `bottommask` units inferred. |
| `CFG` | 6 | Low. Known per install. |
| `SOLVE` | 10 per projector | None. Wrong nominals cost iterations, not correctness. |
| `ASSUME` | 33 | **All of it.** Rev 2 nearly doubled this by splitting photometry per channel — the count went up because the honesty went up, not because the simulator got worse. Rev 3 added two more the same way: `r_wall` and `h_ceiling` were already driving experiment 4's headline as literals in `packages/bench/src/capture.ts`, with no row here at all. Documenting them raised the count without changing a single number. |
| `MEAS` | 5 groups | Blocking for photometric and chromatic metrics only. |

**Highest-risk four, in order:**

1. `γ_R,G,B` divergence — drives the chromatic seam artifact, entirely unmeasured,
   and the mechanism most likely to be visible on a real sphere.
2. `L_black_R,G,B` — tinted uplift in overlaps. Spans a 6× plausible range.
   Disproportionately important because so much SOS content is dark.
3. `E_amb` and its color temperature — crushes contrast and shifts every ΔE.
4. `ρ_R,G,B` — narrower range, but scales every photometric result.

None of the four affect a single geometric metric — but do not read that as
"photometry is geometrically inert", because one photometric constant outside
this list is not. `ρ_room` scales the projector radiance returning from a room
surface, and the decoder gates on exactly that varying term, so it sets how many
false correspondences reach the solver: experiment 4 measures a paired 146× on
pose recovery with a room present. `E_amb` is genuinely different and stays on
this list honestly — it moves only the DC pedestal (`capture.ts:641`), not the
modulation the decoder measures. The sequencing below is unchanged and the
reason for it is unchanged; what is corrected is the generalisation a reader
would otherwise draw from one sentence. **Build and gauntlet the
alignment solver now. Hold blend and legibility work until after the visit.**

---

## Sources

- SOS Operations & Systems Administration (config values) — https://sos.noaa.gov/support/sos/manuals/operations-systems-administration/all/
- SOS Alignment Manual — https://sos.noaa.gov/support/sos/manuals/alignment/all/
- SOS Alignment Tips — https://sos.noaa.gov/support/sos/manuals/alignment/tips/
- SOS Automated Alignment (unsupported) — https://sos.noaa.gov/support/sos/manuals/alignment/automated-alignment/
- SOS Floor Plan — https://sos.noaa.gov/sos/getting-sos/floor-plan/
- SOS First Steps — https://sos.noaa.gov/sos/getting-sos/first-steps/
- SOS Content Creation Guidelines — https://sos.noaa.gov/support/sos/manuals/content-creation-guidelines/all/

*Science On a Sphere® is a registered trademark of NOAA. This document describes
an independent simulator and is not a NOAA product.*
