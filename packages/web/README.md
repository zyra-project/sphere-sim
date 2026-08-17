# packages/web — the interactive simulator

A projected sphere you can walk around, and a calibration you can run.

```bash
npm run build:app     # compile to packages/web/dist
npm run app           # serve on http://localhost:8174/
node tools/smoke-app.ts   # load it in a real browser and check the shader compiled
```

## What is on the page

- **The sphere**, full-bleed, drag to walk around. The graticule is a toggle over
  a base field — black, mid grey, white, or an image you drop on the page. The
  flat fields are the frames §8 items 6–9 and 13 prescribe for judging seams and
  photographing spill; the grid is what the displacement gate measures. They are
  separate controls because they answer different questions.
- **Any equirectangular map you like.** Drop a 2:1 image anywhere on the page — a
  NOAA dataset, Blue Marble, a test chart. It is read in the page, converted out
  of sRGB into the linear light the model works in, and never sent anywhere. None
  ships with the site, which is why none has to have its provenance argued about.
- **Four projectors in the room**, each a coloured lens marker you can click. The
  colour is the same one its tab, its overlay band and its inspect card use.
  Picking one isolates its light. At the default viewpoint you are standing
  *inside* the ring and two of them are behind you, which is true of the real
  room — "Whole room" on the Room tab steps outside it.
- **Each projector's own frame** — the image going down its cable, rendered by
  `packages/sim` from the COMPOSITOR's calibration. Moving a projector does not
  change it; only recalibrating does, which is the least intuitive thing about
  how the system works and the reason it gets a picture.
- **Where it actually is, against where the software thinks it is.** The same six
  facts — distance, height, azimuth, raster, field of view, distortion —
  computed by one function from two rigs, in two columns. Every alignment number
  on the page is the gap between those columns, and the solver only ever sees the
  left one.
- **Its warp mesh.** The config file carries heights and distances in inches;
  what actually removes a doubled grid line is a per-vertex correction on the
  raster, and that is what this draws. It is derived, not illustrated — each
  vertex is followed out to the ball through the calibration the software
  believes and back through the one the lenses actually have. Before a solve it
  is visibly bent; after one it collapses from about 85 px to under 1.
- **Three control sections.** Projectors (move one lens at a time, or switch it
  off), Install (the site survey, as chips and sliders), Room (blend, mask,
  pattern, viewpoint, overlays). Anything class `ASSUME` carries a badge. The
  panel minimises to an icon, because a settings window in the middle of the
  screen with the sphere behind it has no good answer to "how do I move this".
- **Recalibrate**, which photographs the sphere and solves. While it runs you see
  the actual camera frames it is working from, the optimiser's cost falling, and
  the sphere itself converging — the partial calibration is drawn as it arrives.
  Nothing is *measured* from an intermediate: the gauge freedom has not been
  removed yet, so a metric taken from one would be measuring the gauge. When it
  finishes: what it moved and whether it moved to the right place, plus the
  geometry as `sos_stream_control.config` would carry it.

## What is actually happening

Three things run at once, and the division between them is the whole design.

| | What it does | What it may say |
| --- | --- | --- |
| **Main thread** | Draws the sphere with a WebGL2 shader, sixty frames a second | Nothing. It produces pixels and never a number |
| **Model worker** | Runs `packages/sim` on the rig the panel describes | What is true about this installation |
| **Solve worker** | Runs `packages/sim` photographing and `packages/solver` calibrating | What an operator could recover from photographs |

Every number on the page comes from a worker. The shader is never asked for one.
That is not a performance decision — it is the same argument as the `sim`/`solver`
split, one level down. If a readout were computed from the render, a shader bug
would move the picture and the number together, the page would be internally
consistent and externally wrong, and nothing inside it could tell.

## Three rigs

| | |
| --- | --- |
| **as-built** | The rig the room was *specified* as. The drawing. Nobody has this one |
| **truth** | The rig the room actually has — the drawing shaken by the PARAMETERS.md §2 mount tolerances. Ground truth; the solver never sees it |
| **compositor** | What the software *believes*. Starts as the drawing, because that is what an operator types into a config file. After a solve it becomes what `packages/solver` recovered |

Every alignment number is a disagreement between the last two. A simulator run
against itself cannot misregister — it paints the physically correct texel at the
physically correct point by construction — so a page with one rig could show a
beautiful sphere and never show the problem. `packages/sim/src/misregistration.ts`
is the renderer that separates them; `src/glsl.ts` is its GPU counterpart.

## Why there is a third shader in this repository

`packages/harness` has a single-calibration renderer with a verified parity
chain: a line-for-line TypeScript transliteration, a structural test that neither
side may grow a function the other lacks, and a headless comparison against
`packages/sim` in CI. That is a load-bearing artifact, and it cannot show
misregistration, because it has one rig.

So `src/glsl.ts` is its own file with its own runtime check. It is allowed to be
approximate — float32, eight fixed Newton steps in the distortion inversion, one
sample per pixel — and it is not allowed to be a source of numbers.

## The parity readout

The same camera, rendered twice: once by the GPU, once by `packages/sim`'s
`renderTwoRigRoomView` on the CPU in the worker. The disagreement is on screen
and is never hidden.

Two things about how it is judged, both of which took a measurement to get right:

- **The verdict percentile is derived from the boundary allowance**, not chosen
  beside it. Two independent-looking criteria can be quietly inconsistent, and
  these were: an allowance of 2% with a verdict at the 99.5th percentile means
  the percentile always fires first and the allowance is dead code that reads
  like a safeguard. The percentile is `1 - allowance` exactly.
- **The allowance is 1% because that is twice what was measured**, not because a
  perimeter calculation suggested it. The estimate that came first said 2% and
  was four times too large — and at 2% the check could not have failed for a
  difference the size of a complete misalignment, which moves 1.7% of pixels at
  this raster. Both facts are pinned in `test/parity.test.ts`.

What it does **not** cover: `shadeFloor`. The CPU two-rig renderer draws no
floor, so the parity pass turns the floor off on the GPU too. The floor shares
`pixelOf` and the transfer curve with the sphere path, which are covered; its
occlusion test and the room albedo are not.

## Tests

```bash
node --test "packages/web/test/**/*.test.ts"
```

- `settings.test.ts` — every setting has a control and opens in range; the
  Boulder and spec presets differ on exactly the three constants amendment A-36
  names, and on those values
- `rigs.test.ts` — a perfect rig scores essentially zero (and *how* essentially:
  the grid metric's own floor is about 0.01 mm, 1% of its gate); the A-36 `d_proj`
  ambiguity is 3.85 mm at Boulder and exactly zero at the spec's level rig
- `glsl.test.ts` — the shader carries two complete rigs field for field; the
  optics functions take a rig explicitly rather than reading a global; every
  uniform the shader declares is set by the binder and vice versa
- `readout.test.ts` — every metric `sim` produces has plain-language copy; an
  ungated metric can never read as a verdict; a projector's configuration is the
  same rows from either rig, disagrees when the mount is knocked, agrees exactly
  when it is not, and never disagrees about the raster size
- `model.test.ts` — the supplied image reaches the worker, is cached by id, is
  never reused for a different one, and never moves a §7 number
- `mesh.test.ts` — the warp mesh reaches the ball and misses at the corners,
  needs no correction on a perfect rig, wants pixels on a knocked one, and
  vanishes when the compositor is handed the truth — which is what proves it is
  composing two rigs rather than reading one twice
- `parity.test.ts` — the two calibration facts above, measured
- `solve.test.ts` — a real capture and a real bundle adjustment, asserting the
  calibration improves the alignment by more than 2× and that the same seed gives
  the same answer

`tools/smoke-app.ts` covers the things none of them can, by driving Chromium
over the DevTools protocol with nothing but Node 22's built-in `WebSocket`:
whether the GLSL compiles, whether the canvas is lit, and — with `--solve` —
whether a live calibration runs end to end in a browser and actually improves the
number. It fails if the alignment does not get better, which at the default
settings means 127 mm to 0.14 mm.

Two of its checks exist because nothing in Node can make them:

- **The click and the shader agree about where a lens is.** There are two
  ray-casts against the marker spheres — `markerHit` in GLSL, which draws them,
  and `pickMarker` in TypeScript, which decides what a click hit. The tool finds
  a marker by its *colour* in the rendered canvas, clicks it, and asserts the
  page selected the projector whose tint the GPU painted there. If the two ever
  drift, the click picks the wrong projector and this fails.
- **The diagrams have height.** Both panels are flex columns that overflow, and a
  flex item shrinks before its container scrolls — which silently squashed the
  warp mesh to twenty pixels while its caption went on describing a picture that
  was not there.

```bash
npm run app                                    # in one terminal
node tools/smoke-app.ts --solve --screenshot out.png
```

## Why this package may import both `sim` and `solver`

`tools/boundary-lint.ts` forbids `sim` and `solver` from importing each other or
anything but `packages/calibration`. A third package composing both is what
`packages/bench` already is, and it is the only way a solve can be scored at all.

The rule the lint cannot check is the one that matters here: **nothing in this
package may become a path between them.** No helper is shared by both sides. Each
call hands one model's output to the other as data, through the boundary types.
The two workers are separate processes partly to make that structural rather than
a comment — `worker/model.ts` cannot reach the solver even by accident.

## Defaults

The page opens at **NOAA Boulder's published `sos_stream_control.config`**, which
disagrees with `docs/PARAMETERS.md` §1 and §2 on three constants. The spec stays
authoritative for the project's numbers; amendment **A-36** is open and nothing
has been applied to it. The page opens at Boulder's values because it is a
simulator of a real room, and one click restores the documented ones — so the
conflict is visible rather than resolved by a default.
