# packages/bench — the scorer

**Input:** a seed.
**Output:** `bench-results.json`, plus rendered PNGs under `progress/data/`.

```
node packages/bench/src/cli.ts --scenarios 6 --seed 1234 --out bench-results.json
node packages/bench/src/loop.ts                 # one Phase 1 round, fresh seed
node tools/assert-deterministic.ts a.json b.json
```

This is the only package that imports **both** `packages/sim` and
`packages/solver`. docs/ARCHITECTURE.md explains why that is fine and necessary:
something has to hold the ground truth in one hand and the recovered calibration
in the other. What matters is that neither model can reach the other *through*
it — `sim` never imports `bench`, `solver` never imports `bench`, and
`tools/boundary-lint.ts` fails the build if either ever does.

---

## The one rule this package exists to enforce

**The solver is scored on images, never on correspondences.**

The bench could compute `(camera pixel → projector pixel)` analytically and hand
it to `solve()`. It must not. A correspondence handed over that way is a
statement in the bench's own arithmetic, and a solver scored against it is being
asked whether it can invert the scorer. So `capture.ts` renders the whole
structured-light sequence through `packages/sim`'s physics — frustum, distortion,
sphere, `cos(incidence)`, inverse-square falloff, reflectance, ambient, black
floor, shot noise, ADC quantization, camera lens distortion, handheld motion
against a rolling shutter — and the solver's own decoder reads it back. Every
rejected pixel in `DecodeStats` is a pixel a real capture would also have lost.

The one thing the two sides share is a *contract*, not code: the pattern
definition at the top of `packages/solver/src/decode.ts`. The bench implements
the emitter side of that prose and the solver implements the reader side, exactly
as both implement `conventions.ts`. `test/capture.test.ts` closes the loop by
checking a decoded projector coordinate against `packages/sim`'s own forward
projection of the same surface point.

## What lives here

| Module | Responsibility |
| --- | --- |
| `camera.ts` | The observing camera (conventions.ts §C), handheld motion, shutter timing |
| `patterns.ts` | Gray-code and phase-shift patterns, in linear radiance |
| `capture.ts` | Render the sequence, add sensor noise, decode |
| `score.ts` | Gauge alignment, pose/intrinsics/`h_center` error, hybrid calibrations |
| `views.ts` | Two-calibration room view, field maps, PNG output |
| `scenarios.ts` | Seeded scenario corpus, presets |
| `run.ts` | One scenario end to end |
| `attribute.ts` | Naming the largest contributor to a failing gate, by measurement |
| `results.ts` | The `bench-results.json` schema |
| `cli.ts` / `loop.ts` | Entry points |

---

## Reading `bench-results.json`

Designed against three ways a results file can mislead.

**A mean hides a bimodal failure.** Every aggregate carries min, p05, median,
p95, max, standard deviation, interquartile range *and* the raw per-scenario
values in scenario order. This is not decoration: the default corpus is bimodal
by construction, with median grid displacement under a millimetre and a p95 two
orders of magnitude above it.

**A pass rate hides which gate failed and why.** `gates[]` names every gate, how
many scenarios scored it, the worst offender, which scenarios failed, and — for
a failing gate — the single largest contributor, **measured** rather than
ranked. `gates[].dependsOnRecovery` says whether the metric is even a function of
the recovered calibration: off-sphere flux and unlit-within-the-mask are
properties of where the lenses physically point, and no solver can move them.

**A number with no provenance is an assertion.** Every metric carries its gate,
its unit, whether it was scored, whether it is provisional, the sampling scheme
it was computed on and that scheme's convergence check — straight through from
`packages/sim/src/metrics`, unflattened.

### Attribution: three methods, because one does not fit

| Gate | Method |
| --- | --- |
| `grid_displacement` | **Counterfactual substitution.** Replace one recovered parameter group with ground truth, recompute the metric, see how much of the excess disappears. The `none` and `all` bookends say how much of the failure is in the calibration at all. |
| `pose_position`, `pose_rotation` | **Error decomposition.** The metric *is* the recovered pose, so substitution is vacuous. Instead the error is resolved into radial / tangential / vertical (or yaw / pitch / roll) and the dominant direction named. A radial-dominated failure is the field-of-view/distance degeneracy; a vertical one is the floor reference. |
| `h_center_recovery` | **Observability split.** Failing scenarios partitioned by whether a floor reference existed at all. Without one the solver holds `h_center` at the documented value rather than pretending to solve it, and the failure is PARAMETERS.md §8 item 1 not having been carried out. |

Each attribution carries an `explains` string saying what its
`explainedFraction` means, because it means a different thing for each method.

### Determinism

Two runs with the same seed produce byte-identical JSON and byte-identical PNGs.
The things that cannot be reproducible live in exactly two places, named in the
file's own `volatile` array: the top-level `env` block and each scenario's
`timings`. `tools/assert-deterministic.ts` strips those two and compares
everything else, including **key order** — a key order that changes between runs
is an iteration over an unordered structure, which is the exact nondeterminism
docs/ARCHITECTURE.md warns about.

The tool carries its **own copy** of the volatile list and refuses to run if the
file's declaration disagrees. That duplication is the mechanism: with the list in
only one place, anyone could silence a real determinism failure by adding a field
name to it. `test/units.test.ts` is the third party that notices when the two
drift apart.

The check caught two real bugs during construction, and both would have been
paid for later rather than never. A per-scenario wall clock had leaked into
`aggregate.scenarioMs`, which would have made every run differ and forced the
exclusion list wider; it now lives in `env.scenarioDurationsMs`. And the command
line was recorded in `run.argv` — CI runs the bench twice with different `--out`
filenames, so that field differs between two runs that computed exactly the same
thing, and the determinism step would have failed on every commit for a reason
that had nothing to do with determinism. `run` now records what was *computed*
(seed, scenario count, preset); `env` records how the file came to exist. The
determinism test runs the two passes with different output filenames into the
same output directory, exactly as CI does, so the distinction stays enforced.

---

## Scoring pose recovery: the gauge

docs/AMENDMENTS.md A-09 and `packages/solver/README.md` both say it: rotate every
projector and every camera about the sphere centre by one common rotation and
every structured-light residual is unchanged. The sphere is rotationally
symmetric and no projected Gray code references its texture. Those degrees of
freedom are unobservable to **any** solver, and comparing recovered orientations
to ground truth in raw world coordinates measures the gauge rather than the
calibration.

So the bench aligns first, and two details matter:

1. **Only the unobservable axes are aligned away.** The solver *measures* which
   ones those are — with three or more floor references a rig tilt changes the
   predicted heights and becomes genuinely observable, leaving only azimuth free
   — and reports it in `gaugeFreeAxes`. An unconstrained three-degree-of-freedom
   fit would quietly absorb real tilt error into "the gauge" in exactly the
   configuration PARAMETERS.md §8 item 1 asks operators to capture. The
   unconstrained fit is computed anyway and reported as
   `gauge.unconstrainedAngleDeg`, so the size of what *would* have been absorbed
   is visible rather than implied.
2. **Position is scored after the same rotation**, because a global rotation
   moves positions too.

Pre-alignment numbers are reported in full, in
`scenarios[].recovery.preAlignment`. A reader who thinks the alignment is too
generous can read the raw column, which is the only reason to publish a number
you are arguing against.

The fit itself is a small-angle iteration rather than a Kabsch: Kabsch answers
the unconstrained question, and the question here is usually constrained.
Restricting a closed-form fit to a subspace is awkward; iterating on
`R ← exp([ω]×) R` with the fixed axes deleted from the normal equations is not,
and it converges to the Kabsch answer when all three are free. It also handles
the coplanar §2 projector layout that `packages/solver` reports breaks a
polar-decomposition Kabsch.

**Grid-line displacement is gauge invariant** — it compares two projectors'
copies of the same line, and a common rotation moves both together — so the
choice of frame cannot change the one scored geometric gate. It does change the
registration error, which is an absolute placement measurement, so the metrics
are computed against the gauge-aligned rig. The reason is stated in the results:
the unobservable rotation is precisely what PARAMETERS.md §1's `theta_rot`
(class CFG, "sites rotate the sphere mechanically") absorbs in deployment.

---

## Degradation conditions

Experiment 1 needs these separable, so nothing is bundled. A scenario can turn on
ambient without noise, noise without motion, or motion without a rolling shutter.

**Ambient** — PARAMETERS.md §5 `E_amb`, relative irradiance, nominal 0.04 and
stated range 0.01–0.15. Worth knowing what it does and does not do: with no
sensor noise, ambient is a pure DC offset on every frame, and both the Gray
pattern-versus-complement comparison and the four-step phase fit cancel it
analytically. `test/capture.test.ts` pins that the decode moves by under 1e-3
projector pixels across the whole §5 range. That is *why* §5's factor-of-fifteen
uncertainty is not a factor-of-fifteen uncertainty on the geometry. What ambient
does do is raise the shot-noise floor, because shot noise scales with total
signal.

**Sensor noise** — photon shot noise plus read noise, seeded, with saturation and
ADC quantization. The shot term is Poisson, so its variance equals its mean:
bright pixels are noisier in absolute terms and quieter in relative ones, which
is the structure a phase estimate cares about (`σ_φ ∝ σ_I / B`, and both terms
move with `cos(incidence)`). A constant sigma would make grazing incidence look
better than it is. PARAMETERS.md has no section for a camera, so all four sensor
constants are class ASSUME in the spec's sense and are echoed into
`scenarios[].inputs` rather than buried in the code.

**Rolling shutter** — and here is the part that would otherwise produce a false
negative. A rolling shutter on a static scene photographed by a static camera is
*provably* invisible: every row sees the same world. A bench offering "rolling
shutter" as a switch and modelling only the readout would report a clean null
result and Experiment 1 would conclude it costs nothing.

What actually happens in the field is a handheld phone, and the drift hits the
capture in two distinct ways, kept as separate switches so the experiment can
attribute the effect:

- **Between frames.** A sequence is thirty-odd frames and every decode compares
  frames against each other — Gray bit against its complement, four phase steps
  against each other — assuming the camera pixel looks at the same surface point
  in all of them. Inter-frame drift breaks that, and it does so with a *global*
  shutter too.
- **Within a frame.** Row `r` is exposed `r/height × readout` after row 0, so
  the pose varies down the frame and the image is sheared by whatever the camera
  did during the readout. This is the rolling-shutter-specific part.

The motion model is tremor (≈9 Hz, sub-millimetre), sway (≈0.7 Hz, ≈1.5 mm) and
drift (2 mm/s), describing someone deliberately bracing a phone rather than
waving one. Nothing in PARAMETERS.md describes a handheld capture, so these are
`ASSUME` and are reported. `test/capture.test.ts` asserts **both** halves: that a
rolling-shutter capture of a static camera is bit-identical to a global-shutter
one, and that switching the motion on changes the decode. The first assertion is
what makes the null case a *proven* no-op rather than an assumed one.

---

## Cost

Measured on this machine, dominated by the capture render:

| Run | Wall clock | Per scenario |
| --- | --- | --- |
| `--scenarios 6 --seed 1234` (what CI runs) | **99 s / 100 s** on two consecutive runs | 10.5–23.0 s |
| `--scenarios 12 --seed 1234` (all archetypes) | **243 s** | 10.5–37.0 s |

CI runs the bench twice, so the determinism step doubles it.

| Preset | Scenarios | Cameras | Use |
| --- | --- | --- | --- |
| `--quick` | 3 | 224×168 | Plumbing check. Numbers should not be quoted. |
| default | 6 | 320×240 | The loop. What CI runs. |
| `--thorough` | 12 | 640×480 | The honest answer to "does a phone suffice". |

The camera resolution is the cost knob and it is a real modelling parameter, not
a fudge factor: a 320×240 camera 2.6 m from a 1.7 m sphere resolves the surface
at about 8.6 mm per pixel, which is coarser than a phone, and the recovered
numbers are correspondingly pessimistic.

**Not parallelised, on purpose.** Scenarios are independent and worker threads
would cut the wall clock by about the core count. Determinism outranks speed, and
splitting the run introduces a second execution path whose determinism nobody
would notice breaking until a critic diffed two runs and got a spurious
regression. At 100 s a round the saving does not buy that risk. The shape is
already right if a future round needs it: `runScenario` takes a scenario and
returns a plain object, results are assembled in scenario order, and nothing is
shared between them.

---

## The scenario corpus

A fixed ordered list of archetypes with the rest drawn from the seed. Uniformly
random scenarios would spend their samples in the middle of the parameter space
and reach the edges by luck; the edges are named in the documentation
(PARAMETERS.md §2's two- and three-projector installs and its unresolved
`d_proj` conflict, §5's ambient range, §1's `h_center` note, the experiment
plan's camera sweep) and the corpus goes there deliberately.

| # | Archetype | The question it asks |
| --- | --- | --- |
| 0 | `clean` | Is the path wired? Zero misalignment, no ambient, no noise, static camera. |
| 1 | `nominal` | What does a well-built rig in a normally-lit room recover to? |
| 2 | `sensor-noise` | What does shot noise alone cost? |
| 3 | `high-ambient` | What does the top of §5's range cost? |
| 4 | `handheld` | What do a rolling shutter and a handheld phone cost? |
| 5 | `two-cameras` | Is two photographs enough? |
| 6 | `six-cameras` | What does the sixth photograph buy over the third? |
| 7 | `three-projectors` | Does a three-projector install recover? |
| 8 | `two-projectors` | Does the antipodal two-projector install recover? (A-06) |
| 9 | `long-throw` | Does the bootstrap find the far end of §2's `d_proj` conflict? |
| 10 | `no-floor-reference` | What happens to `h_center` with nothing measuring the floor? |
| 11 | `fov-held` | How much of the position error is the fov/distance degeneracy? |

Order is part of the interface: CI runs the first six and compares verdicts
across commits, so new archetypes go on the end. Scenario 0 is always the canary,
whatever the seed — a bench whose path has quietly broken should fail loudly on
the first scenario rather than produce twelve plausible-looking failures. Asking
for more scenarios than there are archetypes cycles the list with fresh seeds:
the same twelve questions asked of different rigs.

Seeds are chained rather than drawn from a clock. Round *N*'s seed is
`splitmix(root, N)` — decorrelated from round *N−1*'s, so a builder cannot overfit
to it, and a pure function of the history, so any round replays exactly by
number. Wall-clock entropy would satisfy the first requirement and destroy the
second.

---

## Things found while building this

Recorded here rather than silently patched.

**The §7 pose gate is not achievable with a 3 mm tape measure, even on a perfect
rig photographed by a noiseless camera.** Filed as **AMENDMENTS A-11**. On the
`clean` scenario — zero injected misalignment, no ambient, no sensor noise, a
static camera, an RMS residual of 1×10⁻⁴ projector pixels — the recovered rig
still carries 2.15 mm of position error and 0.032° of rotation error. The
horizontal error is **0.019 mm**; all the rest is one global tilt about a
horizontal axis, identical on all four projectors. That tilt is observable only
through the floor references, so the recovered rig inherits their noise: 3 mm of
tape-measure error at a 5.18 m radius is `atan(0.003/5.18)` = **0.033°**, which
is two thirds of §7's entire rotation budget. No amount of solver work removes
it; a better tape measure does. The bench reports the horizontal and vertical
components separately so this stays visible instead of averaging into one
number, and `gauge.unconstrainedAngleDeg` (0.0319° here, against a constrained
gauge of 0.0001°) shows exactly how much an unconstrained alignment would have
hidden.

**§7's unlit-within-the-mask gate cannot be met by the 2- and 3-projector
installs §2 says are supported.** Filed as **AMENDMENTS A-10**. Measured on the
nominal geometry: 0% for four projectors, **5.9%** for three, **12.8%** for the
antipodal pair. "Quadrants go dark" and "0% unlit inside the mask" are the same
statement about overlapping regions. The gate is reported and allowed to fail
rather than suppressed for N < 4, with the projector count printed beside it.

**An antipodal two-projector install has no blend region at all**, so grid-line
displacement has nothing to measure. Each lens reaches 80.4° from its own
sub-projector point (§4.3) and the other lens is 180° away, so no surface point
is lit by both. `sim/metrics` correctly reports NaN and `makeMetric` correctly
fails a NaN — but the gate summary lists that scenario under
`scenariosNotMeasurable` instead of counting it as a failure. "This install
fails the seam gate" and "this install has no seams" are different sentences,
and only one of them sends a solver piece back.

**Holding the field of view halves the pose error and changes the residual by
0.4%.** The `fov-held` archetype shares its seed with `two-cameras`, so the two
are the same rig, the same cameras and the same 7 866 correspondences with one
parameter held:

| | `fovHDeg` free | `fovHDeg` held |
| --- | --- | --- |
| Position error (aligned, worst) | 408.1 mm | **152.5 mm** |
| Rotation error (aligned, worst) | 6.29° | **2.61°** |
| Field-of-view error | 2.70° | 0.90° |
| Grid displacement | 70.3 mm | 60.1 mm |
| **RMS residual** | **1.664 px** | **1.657 px** |

Two calibrations differing by a quarter of a metre in projector position fit the
same photographs equally well. That is the field-of-view/distance degeneracy
`packages/solver`'s README describes, measured here independently and from the
image side — and it is why the residual RMS is a bad proxy for recovery quality
on this geometry. PARAMETERS.md §3.1 classes `fov_h` as `SOLVE` and the throw
ratio it derives from as `CFG`; on this evidence the `CFG` reading is the useful
one.

**`converged: false` on the cleanest scenario is honest, not a defect.** With a
residual of 1e-4 projector pixels the fit is below `packages/solver`'s own step
and gradient tolerances, so Marquardt damping runs away before either can fire
and `stopReason` is `lambda`. That is the optimiser refusing to dress a stall as
a convergence, which is exactly what its README says it does. The residual is the
claim; the flag is the diagnosis. Worth knowing before somebody "fixes" it.

**`sim` and `solver` read `d_proj` differently by 40 micrometres.**
`packages/sim`'s `nominalRig` places a lens at `distanceM` in the *horizontal*
plane and then lifts it to `h_proj − h_center`; `packages/solver`'s places it at
`distanceM` in three dimensions and derives the horizontal radius. PARAMETERS.md
§2 defines `d_proj` as "distance, sphere center to lens", which is the solver's
reading. The two agree **exactly** at §2's own nominal, where §1 and §2 put the
lens and the equator at the same 2.1844 m and the lift is zero; with this
corpus's 2 cm of height scatter the disagreement is 40 µm, fifty times below the
§7 pose gate, and it affects only where the solver starts. Not patched: it is a
divergence between two independent implementations, which is what this repository
is built to surface, and the fix belongs to whoever owns `sim`.

**Pushing the transfer compensation onto the pattern generator makes gamma drop
out of the capture exactly.** `decode.ts` requires patterns to be specified in
linear radiance. Inverting conventions.ts §P to deliver a target `T` and
substituting back gives `emitted(T) = clamp(T, gain·blackFloor, gain)` — no
`pow`, no gamma, no dependence on any ASSUME-class exponent. That is not just a
speed win (it is the difference between six `pow` calls per pixel per frame and
three clamps); it is the property `decode.ts` asks for and the reason it asks.
What does *not* drop out is the black floor, which sets the modulation floor the
decoder rejects on. `test/units.test.ts` checks the closed form against
`packages/sim`'s own forward transfer rather than against the bench's algebra.

**The pattern's Gray-plane count has to be derived from the camera, not chosen.**
A 1920-pixel projector with 7 Gray planes has a 15-pixel stride; a 320-pixel
camera 2.6 m from a sphere lit from 5.18 m covers about 4.4 projector pixels per
camera pixel, so that stride is under four camera pixels and the finest plane
sits near the camera's Nyquist limit. It decodes — badly, and in a way that looks
like decoder noise rather than like an under-resolved pattern. `run.ts` measures
the ratio per (camera, projector) pair, takes the worst, and picks the largest
plane count whose stride still spans four camera pixels. A real operator makes
the same choice with the same arithmetic.
