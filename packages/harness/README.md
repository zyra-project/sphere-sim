# packages/harness — the interactive window

```bash
npm run build:web    # compile packages/sim, packages/calibration and this package to browser ESM
npm run harness      # zero-dependency static server on http://localhost:8173/
```

One WebGL2 context, five viewports — a room view plus the four projector rasters
— a live metrics panel, and a slider for every parameter in PARAMETERS.md. It
exists for a human building intuition, and for checking that the metrics track
what the eye sees.

The four projector views are drawn as quadrants of **one framebuffer**, because
PARAMETERS.md §3.4 reads the SOS config and concludes that the deployment target
is a single X screen split 2×2, not four independent outputs. A 2- or
3-projector rig leaves its unoccupied quadrants black rather than repacking the
panel: that is §2's "quadrants go dark", and the X screen does not resize.

## Every slider says where its number came from

PARAMETERS.md §10 counts 31 `ASSUME` constants and says of them: *"All of it.
This is where the bar breaks."* A window that let a human drag those numbers
without saying so would quietly undo that, because a value you can move with your
finger feels like a value somebody checked.

So each control carries the provenance class of the constant it moves, and
`ASSUME` controls are visually distinct — amber, thicker left border, and an
`ASSUME` pill whose tooltip is §10's own sentence. Each also says whether its
**range** is `stated` by PARAMETERS.md, `inferred` by us
(docs/AMENDMENTS.md A-04), or a `harness` framing choice that makes no claim
about uncertainty at all. `test/params.test.ts` pins the counts and asserts that
a control whose travel is wider than the calibration table's range cannot claim
the table's `rangeSource`.

Every photometric metric in the panel is marked **PROVISIONAL**, and
`photometricMetrics` hard-codes the flag rather than reading it from the data —
the phase gate is a property of the phase, not of the run.

## The parity number, and exactly what it does and does not prove

The renderer is GLSL. docs/ARCHITECTURE.md is explicit that this is a **second
implementation of the simulator's own model**, a different thing from the A/B
duplication between `sim` and `solver`, carrying a different risk: not
circularity but **silent drift**. A term goes into one and not the other, the
picture still looks like a sphere, and a human builds intuition from a model
nothing scores.

There are three links in the chain and they are not equally verified:

```
  packages/sim  <--(1)-->  src/reference.ts  <--(2)-->  src/glsl.ts  <--(3)-->  a real GPU
     float64                    float64                    text               float32
```

| Link | What it is | Verified by execution here? |
| --- | --- | --- |
| **(1)** | `reference.ts` is a line-for-line TypeScript transliteration of the shader. Rendered against `packages/sim` pixel by pixel, room track and projector track. | **Yes.** `node --test packages/harness/test/parity.test.ts`, no GPU needed. |
| **(2)** | The shader source is parsed for its function signatures; the reference must expose a counterpart for every one, both directions. | **Yes, structurally.** `test/glsl.test.ts`. This is shape, not arithmetic. |
| **(3)** | A real GL driver compiling that text into the arithmetic the reference describes. | **No — this container has no GPU and no display.** Measured at runtime in the browser and displayed at the top of the metrics panel. |

### Link (3) covers the mesh path too, now

Phase 2 taught the shader to trace a model, and for a while link (3) did not
follow: the page had no way to select one, so the mesh path had never executed on
any GL driver, software or hardware. Every claim about it rested on
`reference.ts` — float64 TypeScript, which is links (1) and (2). That is a whole
renderer verified by not being run.

The **Surface** control puts one of two models in front of the projectors, and
the parity number then covers it. Both are built in `src/fixtures.ts` rather than
loaded, so a disagreement on screen is about the driver and not about a fetch:

- a **tessellated sphere**, the one shape whose right answer is already known,
  with the analytic one beside it. `test/fixtures.test.ts` holds the two against
  each other on the CPU — mean departure 1.2e-2 over lit pixels, which is the
  faceting — so a fixture problem announces itself there rather than being read
  on screen as the driver disagreeing;
- **two plates**, because a sphere is convex and cannot exercise the shadow ray
  at all. Removing that ray from the reference leaves a tessellated sphere
  pixel-identical; it took a concave fixture to catch on the CPU and it takes one
  here.

**What to watch for on real hardware.** `bvhIntersect`'s agreement with the
simulator depends on a NaN propagating through `min`/`max`, which GLSL ES 3.0
does not guarantee — see the known risk below. A driver that answers differently
prunes a subtree containing geometry, which shows up as **holes in the model on
rays looking straight down an axis**, and as a parity failure concentrated there.
That is the failure this control exists to be able to see.

### Measured result for link (3) on a mesh: it FAILS, and not for that reason

Run under SwiftShader (`--use-angle=swiftshader`, the same software GL
`tools/smoke-app.ts` uses), at the page's own 96×72 room and 64×36 projector
sample grids:

| surface | room p99.9 | room over tol. | projector p99.9 | projector over tol. | verdict |
| --- | --- | --- | --- | --- | --- |
| analytic sphere | 1.04e-4 | 0/6912 | 7.84e-5 | 0/2304 | pass |
| tessellated sphere | **2.28e-1** | 50/6912 (0.72%) | **2.08e-1** | 20/2304 (0.87%) | **fail** |
| two plates | **4.43e-2** | 18/6912 (0.26%) | 1.61e-6 | 0/2304 | **fail** |

The predicted failure is **not** what happened. There are no holes, nothing is
concentrated on axis rays, and the picture is lit (30.5% and 15.9% of the canvas).
The disagreeing samples are **isolated single pixels scattered through the
interior**, at facet edges — the signature of the two renderers picking different
adjacent triangles for a ray that lands near a shared edge, which changes the
flat-shaded normal by a facet angle and so produces a near-full-amplitude delta
at one sample. `uvSphere(48,24)` has 2208 triangles across ~4200 lit samples, so
its facets are a couple of pixels wide and almost every sample is near an edge.

**The model itself is not what disagrees.** Rendering the same fixtures at the
same grid through `reference.ts` against `packages/sim`, headless — links (1) and
(2), no GPU — gives p99.9 of **3.8e-6** (tessellated sphere) and **2.4e-5** (two
plates), with **0/6912 over tolerance** in both. The float32 emulation picks the
same triangle float64 does; a real driver, with its own FMA contraction and
transcendental precision, does not, about 0.7% of the time.

**Why the verdict is `fail` rather than forgiven, and why that stays.** `judge()`
used to require both `p999 <= tolerance` and `fractionOverTolerance <=
BOUNDARY_PIXEL_ALLOWANCE`, with the allowance at 1%. Those two were never
independent: if more than 0.1% of samples are over tolerance then the
99.9th-percentile sample *is* one of them, so `p999 > tolerance` follows. The
conjunction reduced to the percentile alone, the second clause could not change
an answer at any input, and **the 1% budget documented for exactly this cause
enforced 0.101%.** On a sphere the boundary population sits under 0.1%, which is
why the contradiction never showed.

That is now one number: `BOUNDARY_PIXEL_ALLOWANCE` is the fraction the verdict
sheds, and `VERDICT_PERCENTILE = 1 - BOUNDARY_PIXEL_ALLOWANCE` is derived from
it, the way `packages/web/src/parity.ts` has always done it. At 0.001 the verdict
is bit-for-bit the p99.9 it always actually applied, so no track moved.

**The mesh still fails, and that is the right answer rather than a leftover.**
Widening the budget to the 1% the old comment claimed would blind this gate:
`test/parity.test.ts` injects a disabled polar mask, which moves only **0.275%**
of a 96×72 room view, and at p99 that bug is not caught at all — its percentile
value is exactly zero. A real model bug and a facet-edge tie occupy the same
range of pixel counts (0.275% against 0.26–0.72%), so **no budget can separate
them**, and one wide enough to pass a mesh is wide enough to pass a broken mask.
Shape almost separates them and not reliably enough to gate on: the two large
injected bugs are 88% and 87% spatially clustered, but the polar mask is 42% on
19 pixels against the ties' 22–30%.

Ties have to be identified by what they *are* — the two renderers picking
different triangles at a shared edge, which both already compute — rather than
budgeted for by counting. That needs the CPU side to report triangle indices
alongside radiance, so it is its own change and it belongs with the commit that
gives the live view a model. **Until then, read the mesh rows as a measurement
and not as a pass/fail.**

**Measured result for link (1):** the delta is **exactly zero** — every channel
of every pixel, in the room track and all four projector tracks, across six
configurations (nominal; radial distortion plus lens shift plus roll plus
azimuth jitter; the colatitude mask reading of A-02; §3.2's diverged transfer
with a tinted ambient; the GGX specular lobe; a two-projector rig with a gaussian
ramp). Both implementations round to the same float32.

The tolerance is nevertheless `1e-6` rather than `0`, because both images are
`Float32Array` and the finest difference the comparison can represent near a
radiance of 1.0 is one float32 ULP, `6e-8`. It is not a loose gate: nudging
`rampGamma` by one part in 100 000 already moves the 99.9th percentile to
`1.6e-6` and fails.

**Link (3) is measured in the window, not here.** The harness renders 96×72 room
pixels and a 64×36 projector sample grid into an offscreen float target, reads
them back, and runs the same comparison against `packages/sim`. The number sits
at the top of the metrics panel with its tolerance beside it; when it goes out of
tolerance the panel gets a red banner naming the track. The GPU tolerance is
`2e-3` of relative radiance — a tenth of PARAMETERS.md §7's tightest photometric
gate — and widens to `1/255` when `EXT_color_buffer_float` is absent and the
read-back has to be 8-bit, which the panel says.

### What the parity number cannot see

The uniform block — rotation matrices, focal lengths, the principal point with
lens shift folded in, the limb cosine — is computed once on the CPU and uploaded.
Both the GPU path and the reference path read the same values, so a bug there is
invisible to parity by construction. `test/uniforms.test.ts` is what stands
there: `uniforms.ts` derives them independently and the test compares its outputs
against `prepareRig`'s to 1e-12.

### Deliberate differences from `packages/sim`

Each is a choice, and the parity number measures it rather than hiding it.

- **float32 on the GPU**, float64 on the CPU. The dominant term in link (3).
- **`p1`, `p2` are not uniforms.** §3.1 holds tangential distortion at zero —
  "Extra DOF overfits" — so the shader drops the terms rather than carrying dead
  uniforms.
- **A fixed eight Newton steps** in `invertDistortion`, where `sim` runs an
  adaptive loop to 1e-14. A GPU in float32 cannot reach 1e-14, and eight steps of
  a quadratically convergent iteration is far past float32 at any coefficient
  this rig carries.
- **One sample per pixel.** `sim`'s Halton supersampling exists so bench PNGs are
  byte-comparable; a live window supersamples by being looked at for more than
  one frame.

### A known risk in the mesh traversal, stated rather than assumed away

`bvhIntersect` descends a subtree when the box test returns **NaN**, and that is
not a quirk — it is what `packages/sim` does, so it is what parity requires. An
axis-parallel ray has an infinite reciprocal on that axis, and a slab plane the
origin sits exactly on gives `0 * Infinity = NaN`. The simulator's test is
`!== Infinity`, which admits NaN and descends; the obvious transliteration
`>= 0` rejects it and prunes a subtree that contains geometry — a hole in the
model, on exactly the rays a viewer looking straight down an axis produces. That
bug was written here, and link (1) caught it on the first deep fixture.

**GLSL ES 3.0 does not guarantee NaN behaviour in `min` and `max`.** So the
agreement is *proven* for link (1) — the reference and the simulator are
bit-identical over 2000 rays on a float32-exact mesh — and is a **known risk**
for link (3), where a device that flushes NaN to zero would prune where the
simulator descends. It cannot be measured in this container. The fix, if a real
GPU shows it, is to make all three paths NaN-free by nudging an exactly-zero
direction component before taking its reciprocal, which changes the answer only
for rays that are exactly axis-parallel. It is not done pre-emptively because it
would move `packages/sim`'s arithmetic to fix a fault nobody has observed.

## Everything stays on the GPU

Five viewports are five draw calls into one context, with `gl.viewport` and
`gl.scissor`. Nothing is read back per frame. There are exactly two exceptions:

- the **parity check**, which cannot be done without a read-back, debounced to at
  most once every 250 ms and run at 96×72; and
- the **metrics**, which are computed by `packages/sim` from the CALIBRATION
  rather than from pixels — deliberately, because a metric derived from the GPU
  image could share a bug with it and move together with the picture, which would
  make the panel agree with the render for the wrong reason.

## What lives here

| Module | Responsibility |
| --- | --- |
| `serve.ts` | Zero-dependency `node:http` static server. Refuses traversal; serves the repo read-only under `/repo/` |
| `index.html` | The page shell. Inline CSS, light and dark, no external request |
| `src/params.ts` | The slider manifest: every control, its class, its range and where the range came from |
| `src/state.ts` | Sliders → `RigCalibration` + `Scene` + `ViewerCamera`, once, so every path agrees |
| `src/glsl.ts` | The shader source, assembled from chunks each naming the `sim` module it mirrors |
| `src/reference.ts` | The line-for-line TypeScript transliteration of `glsl.ts`. Imports no `sim` math |
| `src/uniforms.ts` | The uniform block, derived independently and cross-checked against `prepareRig` |
| `src/parity.ts` | The comparison, the two tolerances, and the verdict rule |
| `src/metrics.ts` | The live panel. PROVISIONAL is hard-coded on the photometric half |
| `web/gl.ts` | Context, program, texture, offscreen read-back target |
| `web/main.ts` | Layout, the five viewports, the panels, the wiring |

## Presets

Named starting points, so the configurations the documents argue about are one
click away rather than eight sliders: §3.2's worked yellow band, §6's child
viewer, dark content with the black floor visible, a three-projector install
(which cannot pass §7's unlit gate — A-10, not a defect), A-02's colatitude
reading of the mask, and a rig shaken to §2's stated mount tolerance.
