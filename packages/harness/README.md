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
