Build sphere-sim: a physically-based simulator of a projected spherical display,
and an alignment solver that calibrates one from camera images.

docs/PARAMETERS.md is the spec. Read it first and treat it as authoritative for
every physical constant, its provenance class, and its uncertainty. Where it
disagrees with something you find online, it wins — the conflicts in it are
deliberate and documented.

Two components, and they must stay independent:

  A) sphere-sim — the forward model. Input: an equirectangular image plus a
     ProjectorCalibration. Output: a simulated view of the sphere in a room,
     plus metrics. Ray-traces projector pixel to sphere surface with its own
     geometry math.

  B) solver — the inverse model. Input: camera images of structured-light
     patterns. Output: ProjectorCalibration. Its own projection math.

HARD CONSTRAINT, non-negotiable: A and B share no geometry code, no projection
math, no distortion model. The only thing crossing between them is the
ProjectorCalibration type — pose, FOV, lens shift, distortion coefficients,
per-channel transfer terms. A bag of numbers, zero math. Enforce with a lint
rule in CI that fails the build on any import across the boundary. Add a README
in each directory explaining the duplication is deliberate. Do NOT refactor it
away, and do not "helpfully" extract a shared module — if you do, the simulator
is scoring its own assumptions and the entire project is worthless.

PHASE GATE — this is the part most likely to go wrong.

Phase 1, OPTIMIZE THIS IN A LOOP: geometry. Pose recovery error, grid-line
displacement across blend regions, registration error, off-sphere flux, unlit
fraction inside the mask boundary. Ground truth is free — the simulator knows
the true poses. Inject known misalignment, run the solver, score the recovery.
Regenerate scenarios with fresh random seeds every round so nothing overfits to
a fixed case. Loop until the numbers stop moving or I stop you.

Phase 2, BUILD BUT DO NOT OPTIMIZE: photometry. Build the per-channel transfer
model, blend ramp, black-floor uplift, ΔE metrics — all of it, fully
parameterized, fully unit-tested. But every constant it depends on is class
ASSUME in PARAMETERS.md, meaning nobody has measured it. Optimizing against
unmeasured constants produces confident nonsense. Implement, test, and stop.
Mark all photometric metric output as PROVISIONAL in the report.

THREE EXPERIMENTS — these are measurements, not optimization loops. Run each
once, produce a plot and a written finding, do not iterate to improve the result.

  1. Camera positions. Sweep 1 through 8 simulated camera positions, plot solver
     recovery error against count. Add sensor noise, ambient light, and rolling
     shutter as separate conditions. Answers: how many photos does a real
     calibration need, and does a phone suffice.

  2. Blend softness vs geometric tolerance. Sweep registration error against
     blend ramp width, find the contour where the seam becomes visible at the
     luminance and ΔE gates. Hypothesis to test: soft blending buys geometric
     tolerance. If true it changes the entire value proposition.

  3. Photometric sensitivity. For each ASSUME-class constant, sweep it across
     its stated plausible range and report how far each metric moves. Output a
     ranked list of which unmeasured constants actually matter. This determines
     what gets measured on the real-sphere visit.

TWO INTERFACES, same core:

  - Interactive harness: one window, one WebGL context, five viewports — room
    view, four projector views, live metrics panel. Sliders for every parameter
    in PARAMETERS.md. Everything stays on the GPU. This is for a human building
    intuition and for validating that metrics track what the eye sees.
  - Headless bench: renders N seeded scenarios, writes metrics to
    bench-results.json plus PNGs to disk. Deterministic. This is what critics
    read. Never screenshot a live window for scoring.

GEOMETRY FACTS worth stating because they are counterintuitive and PARAMETERS.md
derives them: overlap multiplicity never exceeds 2, the unlit polar region is
four-lobed and scalloped rather than a circular cap, and the deployment target
is one framebuffer split into four quadrant viewports, not four independent
outputs. If your implementation contradicts any of these, you have a bug.

PROGRESS PAGE — live, updated as work proceeds. Visuals in priority order:

  1. Solver residual scatter, per projector. Reprojection residual for every
     structured-light correspondence. Structure in the residuals means the model
     is wrong; random means sensor noise. This distinction is invisible in a
     scalar RMS and obvious here. Most diagnostic plot on the page.
  2. Equirectangular error map. Color = registration error per surface point,
     over lat/lon. Shows WHERE the error is, not just how much.
  3. Grid alignment pattern through the full pipeline, rendered as a room view.
     Directly comparable to what an operator sees during SOS Grid Alignment.
  4. Before/after pair: previous best vs current round, same seed, same camera.
  5. Metric sparklines over rounds — trend, not just current value.
  6. Static reference, rendered once at startup and never regenerated: coverage
     and incidence-cosine map over the sphere. This must show overlap
     multiplicity of at most 2 and a four-lobed scalloped unlit polar region.
     If it shows 3- or 4-way overlap or a circular polar cap, you have a bug —
     see PARAMETERS.md §4.2 and §4.3.

  Item 6 is a correctness check disguised as a visual. Build it early.
  Also show current metric values against their gates, and the three experiment
  plots as they complete.

SEPARATE VALIDATION PAGE — not part of the optimization loop, not read by any
critic:

  Photographs of real SOS installations, alongside our simulator's render of the
  same dataset. Purpose is plausibility only: if ours looks nothing like a real
  sphere, the model is broken regardless of metrics. Also inspect the photos for
  evidence about ASSUME-class parameters — the polar mask boundary latitude,
  visible seam structure, ambient wash level. Log any findings as proposed
  amendments to PARAMETERS.md; do not silently change constants.

  Do NOT scrape images. I will supply files. NOAA imagery is generally public
  domain but site-submitted photographs may not be, so treat provenance as
  unknown until I say otherwise.

LOOP MECHANICS — applies to Phase 1 only: break the work into the smallest
pieces that can be improved and judged separately — you decide the decomposition,
I have not prescribed it. Each piece gets a builder and a separate critic with
fresh context. Critics read bench-results.json and the rendered views, never the
builder's reasoning or explanation. When a metric fails its gate, name the single
largest contributor and send it back.

Use subagents. No fixed round count. Do not prescribe or ask me for the
architecture — decide it.
