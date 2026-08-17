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
- **Earth by default, or any equirectangular map you like.** Blue Marble ships
  with the page — see `assets/README.md` on where the file came from — because a
  misalignment that doubles a coastline is the one a person recognises. Drop any
  2:1 image anywhere on the page to replace it: a NOAA dataset, a test chart,
  your own. It is read in the page, converted out of sRGB into the linear light
  the model works in, and never sent anywhere.
- **A room, not a void.** Four projectors on ceiling hangers, the guard rail
  visitors stand behind, the rod the sphere hangs from, and the rail's footprint
  on the floor — sphere-traced as an SDF because a ray-torus intersection is a
  quartic float32 cannot be trusted with. Each projector's lens glows in its own
  colour, the same one its tab and its overlay band use, and clicking one selects
  it. None of it is in the model: nothing emits light, occludes a beam or casts a
  shadow, and the parity pass removes all of it. The page opens outside the ring
  looking at the whole installation; "Standing at it" on the Room tab walks you
  in, where two projectors are behind you — as they are in the real room.
- **Each projector's own frame** — the image going down its cable, rendered by
  `packages/sim` from the COMPOSITOR's calibration. A lune, widest at the equator
  and pinching toward the poles, with the sides faded out where it hands over to
  its neighbours. Moving a projector does not change it; only recalibrating does,
  which is the least intuitive thing about how the system works and the reason it
  gets a picture.

  It looked like a flat disc for two independent reasons, and both had to go.
  The blend was the wrong shape (A-37, above), and the frame was being **gamma
  encoded twice** — `blendedSignal` applies conventions.ts §P's encode on the way
  out of the model, and the canvas painter applied it again, so `^(1/4.84)`. That
  compresses a ramp running 1.0 → 0.5 → 0 into 29 of 255 display levels. The fade
  was in the model the whole time and could not be seen. `FrameImage.space` now
  says which space a frame is in, because the two kinds on this page really are in
  different ones: a camera capture is radiance, a projector frame is a video
  signal.
- **The doubled line, drawn.** The page's headline is a millimetre figure and its
  subject is a pair of lines that do not sit on top of each other; everything
  else — the badge, the gate, the warp mesh — described that pair without ever
  showing it. "At the seams" picks one of the four joins and draws the patch of
  sphere either side of it, with every grid line painted twice: once by each of
  the two projectors that reach it, each in its own colour, and the hand-over
  meridian marked above the plot — inside it a grid meridian falls on the seam at
  the default graticule and hides any rule drawn there.

  It is `worldToPixel(compositor) → pixelToRay(truth) → sphere`, the same
  composition the warp mesh uses, entered from a world point instead of from a
  pixel: where the compositor thinks a point is, thrown by the lens that actually
  exists. Both rigs are needed and neither can stand in for the other — run it
  with one rig twice and every offset is zero, which draws a perfectly aligned
  installation, and that is the failure mode that looks like success.

  The offsets are magnified, and the factor is printed, because at Boulder's
  throw a failing seam is a hundredth of a degree across a thirty-degree window.
  A magnification chosen to look convincing and then not stated is not evidence.
  After a recalibration the same seam is drawn twice, before and after, at the
  same magnification: a comparison at two different scales would be worthless.
  The ring is anchored at the lowest slot rather than at whichever projector
  sorts first by azimuth, because a solve moves the recovered azimuths by a hair
  and that was enough to renumber the seams under the picker.
- **Where it actually is, against where the software thinks it is.** The same six
  facts — distance, height, azimuth, raster, field of view, distortion —
  computed by one function from two rigs, in two columns. Every alignment number
  on the page is the gap between those columns, and the solver only ever sees the
  left one.
- **A blend that is a seam.** docs/AMENDMENTS.md **A-37**: `packages/sim`'s
  default blend ramps inward from each projector's own limb, which leaves the
  middle of a 71°-wide overlap at 50/50 and the neighbour carrying 38% of the
  signal 20° from your own centre meridian. This page opts into `region:
  'sector'` — a longitude wedge crossfading at the seam, which is what an SOS
  compositor does — so a projector's frame is the lune it should be and a
  misalignment shows up at the joins rather than smeared over the whole ball.
  The bench, the three experiments and the harness's zero-delta parity chain all
  stay on the old reading until A-37's four preconditions are met.
- **Its warp mesh.** The config file carries heights and distances in inches;
  what actually removes a doubled grid line is a per-vertex correction on the
  raster, and that is what this draws. It is derived, not illustrated — each
  vertex is followed out to the ball through the calibration the software
  believes and back through the one the lenses actually have. Before a solve it
  is visibly bent; after one it collapses from about 85 px to under 1.
- **Three control sections.** Projectors — ten controls per lens: aim in three
  axes, distance, height, image size, lens shift in two axes, lamp output and
  black level. The last two are Phase 2 and carry `ASSUME` badges, because
  PARAMETERS.md gives no absolute lumen figure anywhere and §3.2 holds the gains
  at 1 and classes them unmeasured. An On / Off pair beside the tabs switches one
  off at the wall — its quadrant goes dark, the framebuffer keeps its size (§2),
  and the unlit figure jumps. That pair is the only control on the page that
  turns a projector on or off: it used to be a second click on the selected tab,
  a hidden gesture on the same target as the most-used one, so the way you found
  it was by accident. Clicking a lens in the room SELECTS it and nothing more —
  it used to isolate as well, putting the other three out, which reads as having
  switched them off. "Show only" on the Room tab is the isolating control, and
  it is a filter on the picture: the rig is untouched and every number below is
  still the whole installation. "Another install" leaves the lamps as they are
  for the same reason: it draws a different MOUNT error, and a projector somebody
  switched off coming silently back on is the same surprise in the other
  direction. Install is the site survey; Room is blend, mask,
  content, viewpoint and overlays. The panel minimises to an icon, because a
  settings window in the middle of the screen with the sphere behind it has no
  good answer to "how do I move this".
- **A picture you can expose, and a reason it needs it.** The sphere is a painted
  ball lit by four projectors, so what it shows is `texture × ρ × cos(incidence)`
  — §1's 0.90 paint, and a cosine that runs to zero at the limb. A demo that
  draws the map as an emissive material has neither term, which is why one looks
  most of a stop brighter than this: measured against the reference app at the
  same framing, its lit pixels averaged 156 of 255 and ours 53. Ours is the
  physically right picture and it is genuinely dim on a bright screen, so "Screen
  brightness" on the Room tab is a viewing gain — class `PANEL`, applied on the
  way to the canvas, excluded from the linear readback the parity check reads,
  and invisible to every metric. It opens at 1.8×.
- **A rig that starts aligned.** The page opens at Boulder's three constants with
  the §2 mount shake at zero, reading `0.01 mm · ALIGNED`. "Another install" draws
  the tolerances, "Bump this one" knocks the selected lens a quarter of a degree,
  and then there is a before to compare the calibration against. A page that opens
  at 127 mm in red has already happened to you and gives you no way to tell
  whether that is the simulator or the room.
- **Recalibrate**, which photographs the sphere and solves. While it runs you see
  the actual camera frames it is working from, the optimiser's cost falling, and
  the sphere itself converging — the partial calibration is drawn as it arrives.
  Nothing is *measured* from an intermediate: the gauge freedom has not been
  removed yet, so a metric taken from one would be measuring the gauge. When it
  finishes: what it moved and whether it moved to the right place, plus the
  geometry as `sos_stream_control.config` would carry it.

## On a phone

The page is one canvas with floating cards over it, and below 820px those cards
were the whole screen. Measured on a 390×844 Safari: controls from 12 to 417, the
projector card from 417 to 791, the readout crushed into the remaining 31 — zero
visible pixels of room. Every desktop check was green throughout, which is why
`tools/smoke-app.ts` now ends with a pass in an emulated phone that asserts the
room is visible between the sheets and that a pinch moves the camera.

What a narrow screen gets instead:

- **Two sheets, pinned to the top and bottom edges**, with the room between them.
  The control sheet opens collapsed under 760px and the action bar stays — a page
  that hides "Recalibrate" in order to show the sphere has hidden the point. The
  projector card stands the readout down rather than stacking on it, because
  stacked they come to more than the screen and the sphere then has nowhere left
  to be tapped, which is also the only way to dismiss them.
- **Gestures that exist.** One pointer orbits, two pinch. The hint line has
  promised "scroll or pinch to zoom" since it was written and a phone has no
  scroll wheel, so until this there was no way to zoom at all. A trackpad pinch
  arrives as `ctrl+wheel` at a much larger `deltaY` and is scaled separately;
  Firefox reports wheels in LINES, so `deltaMode` is normalised — without it one
  notch moved the camera 0.36% and scroll-to-zoom looked broken rather than
  mis-scaled.
- **A hit test the size of a fingertip.** `pickMarkerNear` samples rings outward
  from the contact point and takes the nearest hit. A projector body is about ten
  CSS pixels across on a phone, so an exact ray answers "nothing" for taps that
  visibly landed on one. It cannot pick the far projector of a close pair and it
  cannot see through the sphere; both are asserted.
- **A field of view chosen from the aspect.** `viewFovDeg` is horizontal and the
  renderer derives the vertical half-angle from the raster, so 71° across a
  portrait phone is a 114° vertical field: the room stretches away at top and
  bottom and the sphere in the middle is forty pixels wide. A narrow screen opens
  at whatever horizontal angle holds the vertical one at 78°.

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

Three things about how it is judged, each of which took a measurement to get
right and each of which was wrong first:

- **The verdict percentile is derived from the boundary allowance**, not chosen
  beside it. Two independent-looking criteria can be quietly inconsistent, and
  these were: an allowance of 2% with a verdict at the 99.5th percentile means
  the percentile always fires first and the allowance is dead code that reads
  like a safeguard. The percentile is `1 - allowance` exactly.
- **The allowance is twice what was measured**, not what a perimeter calculation
  suggested. The estimate that came first said 2% and was four times too large.
- **It is a fraction of the LIT pixels, not of the frame** — and that one was
  load-bearing. As a fraction of the frame the number is not a property of the
  two renderers at all, it is a property of how much of the window the sphere
  fills. A complete mount error moves 40.1% of the frame at a seam close-up,
  4.65% standing at the ball and **0.70% from across the room** — under the old
  1% allowance. The page's own self-check would have passed a rig in pieces at
  exactly the framing that shows the room best, which is now where the page
  opens. Against lit pixels the same three renders give 40.6%, 48.6% and 47.8%,
  with boundary noise flat at 5–6%, so one allowance means one thing at every
  zoom. A patch with fewer than 60 lit pixels reads BLIND rather than passing.
  All six measurements are pinned in `test/parity.test.ts`.

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
