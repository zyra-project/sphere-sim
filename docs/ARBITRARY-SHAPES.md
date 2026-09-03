# Arbitrary shapes: a feasibility study

**Status: Phases 0–4 landed. Phase 5 (the solve) is unimplemented.** Phase 2's
shader wiring landed after this line last claimed it was outstanding; both
renderers now trace and shade a mesh, the harness page can put one in front of
the projectors, and link (3) passes on both mesh fixtures under a software
driver. Phase 3 closed by deciding the polar mask is refused rather than
generalized — see that phase.

**Phase 2 is wired.** The app page hands its display shader the dropped model:
`main.ts` prepares both rigs on one `MeshSurface` and passes `packMesh`'s result
to `buildDisplayUniforms`, and the worker traces its parity image on the same
model and reports which one it used, so the check compares like against like or
withholds its verdict. `tools/smoke-app.ts` asserts the triangles reach the GPU,
because every other check in the repo passed throughout the period they did not.

The plan's condition for wiring it was that `packages/web/src/parity.ts` say what
its verdict means on a mesh. That condition was met first, and in the opposite
direction to the one this paragraph used to predict. It said "its value would pass a mesh; its meaning has
not been re-derived", and the first half is true and IS the problem. Measured
against the real GL read-backs behind `packages/harness/README.md`,
`BOUNDARY_LIT_ALLOWANCE = 0.06` passes a mesh — and it also passes a mesh whose
shader carries the self-shadow acne of Phase 2's own fix, which this very check
found. On the room track that defect moves 1.187% of lit pixels on a tessellated
sphere and 2.198% on two plates, with the worst pixel 193× the tolerance, and a
defect that size hides entirely inside the 6% a p94 percentile discards. Over the
thirteen driver dumps, 0.06 catches 3 of the 14 judgeable cells.

So the allowance was never too tight for a mesh. It sat 5× above the weakest
signature it had to see, and the correction was to make it smaller — 0.002, sized
against that defect rather than against a camera nudge, which overstates the
population it stood in for by three orders of magnitude. Separately the
denominator was counting every pixel the surface covers rather than the pixels a
projector reaches, which let a complete mount error read as agreement on
geometry that self-occludes. Both are fixed; the remaining gate is the wiring
itself, plus one read-back from a hardware GPU, since every correct-renderer
frame measured so far is a software rasteriser.

**What the mesh path cost to make honest**, recorded because the study's estimate
did not include it: wiring the shaders was the smaller half. Link (3) failed on
first contact with a real driver, and the cause was a renderer bug rather than a
tolerance question — self-shadow acne, because the shadow bias is spent along the
ray and clears a facet by only `bias · cos(incidence)`. At this rig's minimum lit
cosine of 0.0090 that is a 111× shortfall. Two rounds of analysis blamed
float32 facet-edge ties before anyone counted the population the explanation
needed and found it empty. See `packages/harness/README.md`.

A **scene occluder** — an object that blocks projector light without being the
projection surface — is the feature the mask stands in for. It does not exist,
and it is not a phase here; it is recorded in Phase 3 with what it would cost.

This document answers a question — how hard would it be to let
a user drop in a GLB or an OBJ, put the projectors wherever they like, and get
real projection mapping out — and proposes a plan. It began as a study that
changed no constant, no gate and no line of code; each landed phase below now
also records what building it cost and where the study was wrong.

## The question is really four questions

They have very different answers, so they are separated before anything else:

| | Question | Answer |
| --- | --- | --- |
| **Q1** | Render an arbitrary mesh, projectors anywhere, and show coverage, overlap and blend | Tractable. ~2–4 weeks |
| **Q2** | Emit a usable warp and blend for that mesh — the projection-mapping deliverable | Tractable, and mostly already built |
| **Q3** | Recover the calibration from photographs, the way `packages/solver` does today | Hard. Months, and partly research |
| **Q4** | Keep the metrics, the gates and the parity chain meaning something | **This is the expensive one, and it is the one that decides the shape of the project** |

Q1 and Q2 are a renderer feature. Q3 is a second project. Q4 is the reason this
document exists rather than a branch.

## What is already shape-agnostic

More than one would expect, because the codebase was factored along the right
seams for reasons that had nothing to do with meshes.

- **`packages/calibration`.** `ProjectorPose` is already full six degrees of
  freedom — `position: Vec3` plus yaw, pitch, roll. Nothing in the boundary
  object constrains a projector to a ring. That constraint lives entirely in
  `nominalRig`, which places lenses at `NOMINAL_AZIMUTHS_DEG`, and in the web
  panel, which offers deltas on top. Intrinsics, transfer and viewport are all
  independent of what is being lit. Exactly one interface is sphere-shaped:
  `SphereCalibration { radiusM, centerHeightM, rotationOffsetDeg }`.
- **`packages/sim/src/optics.ts`.** `pixelToRay`, `worldToPixel`, Brown-Conrady
  and its Newton inversion. Pure interior orientation; it does not know what the
  ray hits. The only sphere terms on `PreparedProjector` are `radiusM`,
  `distanceM`, `limbCos` and `limbAngleDeg`, and all four are conveniences.
- **`packages/sim/src/blend.ts`.** Its own header already says it: "It knows
  nothing about the sphere." It takes `t ∈ [0, 1]` and returns a weight.
- **`shading.ts`, `color.ts`, `photometry.ts`, `png.ts`, `random.ts`, `vec.ts`.**
- **`packages/solver/src/silhouette.ts`.** It thresholds, labels components and
  picks the one that does not touch the frame edge. No radius, no pose, no
  geometry of any kind. It finds an arbitrary object in a photograph as
  willingly as it finds a ball.
- **The warp mesh.** `packages/web/src/protocol.ts` already defines `WarpMesh`
  and `packages/web/src/model.ts` already computes it: for each vertex of a
  projector's raster, follow the pixel out to the surface through the
  calibration the compositor is using, then ask the real rig which pixel would
  have to be lit to put light on that same point. **That is the projection-mapping
  primitive**, already built, already tested by `mesh.test.ts`. It is derived
  from a surface intersection and nothing else, so it generalizes the moment the
  surface does.
- **The display shader already ray-marches signed distance fields** for the
  guard rail, the suspension rod and the projector bodies. The question "how do
  I intersect something that is not a sphere, in GLSL" has a precedent in the
  same file.

## What is sphere-specific, in four tiers

The tiers are the plan's spine: they are ordered by what kind of work each needs,
not by how much.

### Tier 1 — mechanical substitution

One function changes and the call sites follow.

- **`raySphereIntersect` → ray-mesh intersection.** 44 non-test call sites across
  15 files, but they are all the same call with the same signature. On the CPU
  this needs a BVH and a ray-triangle test. On the GPU it needs the BVH in
  textures — see Phase 2 for why an SDF is the wrong shortcut here.
- **The inverse-square reference distance**, `p.distanceM - rig.radiusM`, becomes
  distance to the model's bounding sphere or to the aim point. **Done, one round
  late.** It was written here as mechanical and then not carried out with the
  rest of Phase 1, and review found it: `distanceM` is measured from the lens to
  the ORIGIN and `radiusM` was a bound about the origin, which is one statement
  on a sphere §W puts there and two on a model standing anywhere else. A facade
  20 m out with 5 m of extent gave a projector 30 m away a reference distance of
  5 for a surface it was 10 to 15 m from, and rendered it at a quarter
  brightness — with the sign of the error depending on which side of the origin
  the lens sat. It is now `|lens − centre| − extentRadiusM`, computed once in
  `prepareProjector` instead of at the three call sites that each wrote the
  subtraction out, and `Surface.centre` is the third fact that pair needed:
  `boundsRadiusM` is a size about the origin, `extentRadiusM` a size about the
  centre, and without the centre a caller holding both cannot say where the
  second is measured from.
- **The floor plane and the room box.** `centerHeightM` becomes the model
  origin's height above the floor and nothing else changes.

### Tier 2 — re-derivation

The code is fine. The *definition* stops meaning anything, and a mechanical port
would produce a plausible picture computed from a quantity that no longer exists.

- **Content parameterization.** `worldToLatLon` into an equirectangular image is
  a bijection *because the surface is a sphere*. A mesh needs either the UV set
  the GLB carries or a projection onto it. **This is the single biggest design
  decision in the whole exercise**, and it is where arbitrary projection mapping
  is won or lost. Recommendation: carry both. Use the file's own UVs when it has
  them, since that is the authoring path anyone doing projection mapping already
  works in, and keep a spherical projection as the fallback so existing
  equirectangular content still lands on a mesh.
- **The blend weight.** Today `t = (θ_max − θ) / width` with
  `θ_max = acos(R/d)` — *the sphere's limb*. An arbitrary mesh has no single limb
  angle, so the quantity is not merely wrong, it is undefined. The `'sector'`
  region (AMENDMENTS A-37) is worse: it hands each projector a longitude wedge
  measured from lens azimuth, which presumes a ring of lenses around a
  rotationally symmetric object.
  > **This originally proposed a screen-space distance transform — rasterize each
  > projector's footprint in its own raster, distance-transform it, ramp on that.
  > Implementing it proved that wrong.** `w_width` is an angle ON THE SURFACE —
  > 20° of arc, about 0.30 m at R = 0.8636 — and a screen-space field can only
  > measure angle AT THE LENS. Near a limb, which is exactly where the ramp
  > lives, the two diverge violently: at the nominal rig, 20° at the lens is 73
  > cells of a 128-cell field while the sphere's whole silhouette is 35 cells in
  > radius, so the ramp comes out wider than the footprint and can never
  > complete. Measured against the closed form it departed by **0.46** of a
  > normalized weight, on a scale whose whole range is 1. Phase 3 records what
  > replaced it: the same distance, measured along the surface instead.
- **Self-occlusion.** A sphere is convex, so `dot(normal, lens − point) > 0` plus
  a raster-bounds test *is* the visibility test, and `isIlluminatedAt` is
  complete as written. A mesh is not convex. Every point needs a real shadow ray
  per projector. This is physics the sphere version never needed, and it is
  precisely what makes projection mapping interesting: concavities only one
  projector can reach, hard shadows cast by the object onto itself, and coverage
  holes that are nowhere near a pole.
- **The polar mask.** `set bottommask 60,70` attenuates the sphere's EXPOSED
  SOUTH cap; the north needs no software mask because a ceiling mount already
  occludes it physically, which is what `bottomOnly` records. On a mesh it means
  nothing — there is no pole and no cap. **Decided in Phase 3: refused, not
  generalized.** The proposal here to paint a mask in surface UV was wrong; see
  that phase for why, and for what the mask actually stands in for.
- **Footprint framing.** `intrinsicsFromThrow` inscribes the sphere's silhouette
  in the raster's minor dimension with margin (AMENDMENTS A-01). For a mesh that
  becomes "fit the projected bounding volume", which is a harder computation and
  a worse fit, because a mesh's silhouette is not a disc.

### Tier 3 — the honesty structure

The expensive tier, and the one worth protecting rather than working around.

- **Three renderers must stay in agreement.** `packages/sim` on the CPU in
  float64; `packages/harness/src/glsl.ts` with its line-for-line TypeScript
  transliteration and its headless comparison; `packages/web/src/glsl.ts` with
  `parity.ts` measuring GPU against CPU at runtime and putting the number on
  screen. `glsl.test.ts` enforces that neither side may grow a function the other
  lacks. **Every geometry change is a threefold edit against a measured
  agreement number that must not regress.** This is the largest hidden cost
  multiplier in the project and simultaneously the property that makes it worth
  anything.
- **The metrics are sphere integrals.** `metrics/sampling.ts` is a Fibonacci
  equal-area lattice *on a sphere*; `unlit.ts` and `coverage-stats.ts` bisect on
  latitude; `grid.ts` localizes a line by scanning along the sphere surface and
  reports millimetres of arc. Equal-area sampling of a mesh is a solved problem
  (area-weighted triangle sampling), but "unlit polar area fraction" and
  "coverage boundary latitude" have no analogue at all, and grid displacement
  needs a surface walk rather than a great circle.
- **The gates do not port.** PARAMETERS.md §7 and `gate-waivers.json` are numbers
  about one 130-inch sphere at 5.18 m throw. So are the three geometry facts the
  README says the implementation must reproduce: overlap multiplicity never
  exceeding 2, the four-lobed scalloped unlit region, and the 2×2 quadrant
  framebuffer. They are *sphere theorems*, asserted in tests and pinned by
  `progress:reference:check`. On a mesh they are false — not because the code
  broke, but because the claim was about a sphere.
- **The boundary lint.** `sim` and `solver` may not share code, and a GLB or OBJ
  parser is needed by both. It cannot become a shared package without destroying
  the invariant the whole project rests on. The right move is the one the project
  already makes everywhere else: **put the parsed mesh in `packages/calibration`
  as data.** Vertex, index, normal and UV arrays are data, not mathematics, so
  `tools/boundary-lint.ts` admits them under the existing rule — and each side
  then builds its own BVH and writes its own intersection routine, exactly as
  each side today writes its own distortion model. The recovery scores stay
  non-circular.

### Tier 4 — the solver

- **The residual chain substitutes mechanically.** Camera pixel → world ray →
  surface → project into the projector → subtract the decoded pixel. Only the
  third step changes.
- **The gauge analysis inverts, in our favour.** `bundle.ts` carries an elaborate
  inner-constraint gauge *because a sphere is rotationally symmetric*: rotate
  every projector and camera about the centre and no residual moves. Three
  exactly-null degrees of freedom. An arbitrary mesh generally has no continuous
  symmetry, so those three become observable and the machinery is not needed. It
  must not be deleted, though: a cylinder, a dome and a box each have their own
  null space, so the code has to **measure the null space of the model it was
  handed** rather than assume one.

  This paragraph used to end "`gauge.nullTolerance` already does exactly this
  kind of measurement ... so this is a widening of an existing idea rather than a
  new one." **The code refutes that.** `floorResponse` (`bundle.ts`) reads exactly
  two columns — the referenced entity's z and `h_center` — and is the true
  derivative of the floor row, so it can never see correspondence-block
  stiffness; run unchanged on a mesh it would report zero floor coupling for
  azimuth and pin a direction the mesh data determines. The quadratic form a
  general measurement needs is argued against in the same file, on a units
  objection that survives on a mesh. Phase 5's gauge item is a NEW statistic, not
  a widening, and this entry was mis-sized on the strength of that sentence.

  **DONE, and the prediction in the paragraph above was exactly right — it cost
  120 to 290 mm before anyone went looking for it.** A tri-axial fixture
  (1 : 0.6 : 0.35) recovered 133.4, 119.9 and 287.2 mm on three seeds, and the
  failure was attributed in `initialize.ts` to the bootstrap, with a hypothesis
  about rung 1's single-radius sweep. Isolating it refuted that: rung 1's
  distances are right, `dltPose` recovers a tri-axial body to 0.00 mm on
  consistent data, and `nominal` wins rung 2's comparison on the near-spherical
  fixture that DOES recover. Ablating the gauge alone took the same fixture to
  7.6e-11 mm on all three seeds.

  `correspondenceStiffness` (`bundle.ts`) is the new statistic. It answers the
  units objection rather than dodging it: the ratio is formed on the
  correspondence block ALONE, with the floor and prior rows subtracted from both
  the numerator and the mean diagonal, so a uniform rescaling of the decode
  sigmas cancels exactly and the tape measure never enters. The verdict is taken
  in the rotation SPACE, by diagonalising the stiffness Gram over whatever the
  floor test left, for the same reason the floor test is: with few floor
  references the stiff direction is generally a mixture rather than an axis.

  What it measures, on the azimuth direction, at 192x384, on three seeds each:

  | fixture | stiffness, seeds 1 / 2 / 3 | gauge |
  |---|---|---|
  | analytic sphere | -4.3e-19 / -6.0e-19 / -1.6e-18 | pinned |
  | tessellated sphere | 6.0e-9 / 1.2e-8 / 8.1e-9 | pinned |
  | oblate 1 : 1 : 0.9 | 5.2e-9 / 7.0e-9 / 5.7e-9 | pinned |
  | oblate 1 : 1 : 0.7 | 4.6e-9 / 6.5e-9 / 5.0e-9 | pinned |
  | tri-axial 1 : 0.6 : 0.35 | 1.2e-5 / 1.7e-5 / 1.7e-5 | free |

  The three spheroid rows read alike because they ARE alike: a spheroid is
  rotationally symmetric about z at every squash, so its azimuth is unobservable
  in fact and what is left is the accident of where the facets fell — which does
  not vary with how flat the body is. That leaves a three-order gap with no
  fixture in it, 1.2e-8 to 1.2e-5. The tolerance is 1e-6, near its geometric
  middle, and it is chosen rather than derived because the physics has no bright
  line in it — see `GaugeOptions.dataTolerance`. Every pinned row above recovers
  to the same number it did before the change, and the analytic sphere is
  byte-identical across the twelve-scenario baseline: 188 digests, 5 563 347
  characters, plus `assert-deterministic` across two fresh runs.
- **The model's pose is HELD, and this bullet used to say the opposite.** It read:
  "Hand the solver a GLB and where the object sits and how big it is are solve
  variables: six more parameters, seven with scale." That contradicted the bullet
  directly above it — which argues a mesh's asymmetry makes the sphere's three
  rotations observable, so the gauge machinery "is not needed" — and both cannot
  hold: with a free model pose, rotating rig and model together is null for ANY
  shape, so the gauge GROWS to six or seven rather than shrinking to zero.

  The author settled it: a visitor supplies the model already placed and scaled
  in world coordinates. Requiring that is a product decision, not a measurement,
  and it is the smaller problem — the model contributes no bundle parameters, the
  gauge stays at the three global rotations, and the mesh Jacobian REPLACES
  `intersectSphereJacobian` inside the existing camera block instead of adding
  one. It also largely dissolves the bootstrap's chicken-and-egg below, since a
  PnP has a known pose to intersect against.
- **Bootstrap breaks — and MEASUREMENT has moved where.** This bullet used to
  read: "`initialize.ts` reaches a convergent basin partly because a sphere's
  silhouette is a circle from every viewpoint. A mesh's is not. The replacement
  is PnP from clicked correspondences, a marker pass, or a coarse pose search."
  The named difficulty was that the DLT's 3D points come from intersecting
  camera rays with the surface, and on a mesh there is nothing to intersect until
  a model pose exists.

  **That chicken-and-egg is a consequence of a FREE model pose, and the pose is
  held.** A visitor supplies the model already placed, so there is a known
  surface to intersect from the first ray. It dissolves. Rungs 1 and 3 needed no
  change at all — they hand their options straight to `runBundle`, so they have
  been solving against a dropped mesh since `BundleOptions.surface` landed. Rungs
  0 and 2 built world points themselves and are now threaded, which was measured
  to change almost nothing: against a build with those two rungs forced back onto
  the sphere, across ellipsoids, an offset model and a 45-degree-wrong nominal
  layout, the differences are chaotic in sign and smaller than the seed-to-seed
  spread.

  **A strongly ASPHERICAL object used to fail, and the cause was not here.** On a
  tri-axial ellipsoid (1 : 0.6 : 0.35) the recovered pose was **120–435 mm across
  six seeds** against §7's 2 mm, and tripling the correspondences (1 946 → 5 698)
  made it **worse**, 133 → 231 mm — a degeneracy rather than sampling, with the
  field of view going along with it, 0.936° then 1.537° against 0.022–0.054° on
  near-spherical meshes.

  That was the **gauge**, not the bootstrap: `gaugeUnobserved` was pinning three
  global rotations a held mesh determines, and because the gauge is pure damping
  it froze whatever the bootstrap handed over. See the gauge bullet above, and
  `correspondenceStiffness` in `bundle.ts`. The same fixture now recovers to
  about **1e-10 mm** on every seed, from the same unchanged bootstrap. The
  paragraph is kept rather than deleted because the wrong attribution is why the
  right one took three commits to find.

  The hypothesis, stated as one: rung 1 collapses the search to one dimension by
  placing every projector at ONE distance along its NOMINAL bearing, and that
  collapse needs the object to be roughly centrally symmetric about the origin.
  A rung 1 that searches something other than a single radius is the part of this
  module that really is research.

## The recommendation

**Do not mutate sphere-sim into shape-sim.**

Introduce a `Surface` interface with the sphere as its first implementation, and
make the acceptance test for that refactor **a byte-identical `bench-results.json`
and a clean `progress:reference:check`**. The repo already runs both, so unlike
most refactors this one is mechanically verifiable: if the abstraction changed
anything, the bench says so in bytes.

Then add a mesh implementation behind an explicit mode, and keep every
sphere-specific gate, metric, experiment and reference on the sphere path. Two
shapes, one renderer, one set of claims per shape.

The alternative — a general renderer under sphere-flavoured gates — quietly turns
every number on the progress page into a claim about a shape nobody specified.
That is the exact failure the project's honesty structure was built to prevent,
and it would be self-inflicted.

## The plan

### Phase 0 — the seam. No behaviour change. **LANDED**

`packages/sim/src/surface.ts` defines `Surface`, and `SphereSurface` implements
it by delegating to the same `geometry.ts` functions the call sites used to call
themselves:

```
intersect(origin, dir, tMin?) -> { t, point, normal } | null
coordAt(point)                -> the content coordinate there
pointAt(coord)                -> the surface point at a content coordinate
normalAt(point)               -> outward unit normal
sampleArea(n)                 -> equal-area surface samples
```

Every direct sphere call in `packages/sim/src` now goes through it, as do the
consumers in `packages/bench`, `packages/web` and `packages/experiments` —
including `experiments/src/photometric/artifact.ts`, whose `walk` now takes a
`Surface` rather than a bare radius. Three places deliberately do NOT follow the
seam, and each says why in situ:

- `packages/harness/src/glsl.ts` and `packages/harness/src/reference.ts` — the
  shader and its line-for-line transliteration. Their whole job is to be an
  independent re-implementation, so routing them through the simulator's seam
  would delete the thing the parity chain measures. Phase 2's territory.
- `packages/web/src/glsl.ts` — the display shader's own GLSL, which intersects a
  sphere analytically. Also Phase 2's.
- `pickMarker` in `packages/web/src/uniforms.ts` — it picks against `PackedRig`,
  the flat Float32Array payload the shader is handed, so it has to answer the
  question the *shader* would answer. Until the GPU learns about shapes, a seam
  there would let the picker and the picture disagree about what was hit.

**Measured, not asserted:**

| Gate | Result |
| --- | --- |
| `bench --scenarios 12 --seed 1234` against the same command before the change | **identical** — 5,563,347 characters, `env` and per-scenario `timings` removed |
| `progress:reference:check` | clean: multiplicity ≤ 2, four-lobed scallop, boundary matches closed form |
| `npm test` | 844 pass, 0 fail (8 new, in `test/surface.test.ts`) |
| `typecheck`, `lint:boundary`, `check:license`, `build:app`, `smoke:app` | green |

What the interface deliberately does **not** yet carry: a bounding volume
hierarchy, per-triangle UVs, and a shadow query that is more than "does this
point face the lens". Those arrive with a mesh that can exercise them. The
content coordinate is still a latitude and a longitude — widening it now would
mean inventing a coordinate no implementation uses, and the conversion would
move arithmetic that the byte-identity gate exists to pin.

*Estimated 3–5 days; the seam itself came in under that because the call sites
were uniform. The estimate stands for anyone repeating it — most of the time
went on establishing the baseline and reading each call site, not on typing.*

### Phase 1 — a mesh on the CPU. **IN PROGRESS**

**Landed:** `SurfaceMesh` in `packages/calibration` (arrays only — R2 proves
there is no arithmetic in it, so no traversal can be smuggled across the
boundary). `packages/sim/src/mesh/bvh.ts` and `mesh/surface.ts`: the simulator's
own bounding volume hierarchy, its own ray-triangle test, self-occlusion, and
area-weighted triangle sampling that replaces the Fibonacci lattice on the mesh
path. `MeshSurface` is the second `Surface` implementation, which is what turns
Phase 0 from a rename into an abstraction. And `packages/meshio` — the GLB
reader.

`isIlluminatedAt` no longer assumes convexity. `Surface` gained `facesLens` and
`shadowed`, and `coverage.ts` runs three tests cheapest-first — facing, then the
raster, then the shadow ray — so the hierarchy traversal only happens for points
that already passed the other two. `SphereSurface.shadowed` returns `false`
unconditionally, which is not a stub: a convex body cannot come between a point
on itself and anything outside it, and that is precisely why the whole of Phase 0
could treat "faces the lens" as the entire visibility test.

`prepareRig` takes an optional `Surface`, so a mesh reaches the renderer through
the ordinary entry point. **`renderRoomView` needed no work at all** — Phase 0
routed it through `rig.surface` and the coverage wiring finished the job.
Measured rather than assumed: swapping a `MeshSurface` (a 192×96 tessellated
sphere) into a `PreparedRig` gives 648 camera-ray hits either way, a mean
absolute difference of 5.7e-5 in linear radiance against the analytic sphere, and
about 4.5× the render time for a hierarchy traversal against a closed form.

**The blend and the polar mask are REFUSED off a sphere, not approximated.**
`blendModelApplies` is the single place that decision is made. Both are written
for a sphere and stop being defined on anything else: the ramp measures `t`
inward from `theta_max = acos(R/d)`, the sphere's limb, and a mesh would hand
back the angular radius of its *bounding sphere* — a number, not an answer,
because it is not the distance to the edge of the projector's footprint. The mask
keys on a latitude that off a sphere is a UV coordinate wearing a latitude's
name.

So on a mesh every projector reaching a point contributes equally and the mask is
1. That draws hard seams where each footprint ends, and that is the point: a
crossfade computed from a bounding sphere would look like a blend, photograph
like a blend, and be a claim about a shape nobody measured. **A visible seam is a
true statement about coverage; a smooth gradient would be a false one.** Phase 3
replaces the predicate with a geodesic distance to the footprint edge.

**A dropped `.glb` reaches the app.** `mediaKind` routes a model away from the
content path — it is the shape the content goes on, which is a different
question — and `packages/meshio` reads it in the page. A third worker request
kind, `'surface'`, lights it and returns a CPU render plus three facts that are
honest on any shape because each is a count over equal-area samples of the
surface itself: what fraction of the area is lit, how many projectors deep it is
on average, and **what fraction faces a projector and is dark anyway because the
model is in its own way** — the number that cannot exist on a sphere.

It is a third request kind rather than a field on the metrics request, and that
matters: the metrics path answers PARAMETERS.md §7 about a 130-inch sphere and
re-runs on every settling slider. Threading a mesh through it would put a
hierarchy traversal in the interactive loop and make a §7 gate answerable about a
shape §7 was never written for.

**The live view stays the sphere, and the page says so.** The display shader
intersects one analytically; a mesh on the GPU is Phase 2. Quietly loading a
model while the canvas keeps drawing a ball is the one thing this page must not
do — every number it prints comes from the model rather than the picture
precisely so the two cannot drift apart unnoticed, and a mesh in the metrics with
a sphere on screen would be that drift, installed on purpose. So the model is
traced on the CPU, shown beside the live view, and the caption states the
difference along with the fact that blending and the mask are switched off rather
than approximated.

**Still to do:** carrying a mesh through `RigCalibration` itself — see below for
why that is deliberately not this change.

**Where the byte-identity gate nearly broke, and what it forced.** The obvious
implementation of `SphereSurface.facesLens` uses the normal it is passed. It is
algebraically identical to the old expression — a sphere centred on the world
origin has its normal parallel to its position, so the two differ by the positive
factor `1/R` and can never differ in sign. They can differ in the last bit, and
there is exactly one place where that matters: `coverageBoundaryLatitude` bisects
sixty times to find the latitude at which this test flips, converging to within
about 1e-18 of the terminator — the one neighbourhood where two algebraically
identical expressions round to opposite sides of zero. That boundary feeds
`unlitPolarAreaFraction`, which feeds `bench-results.json`, which is byte-compared.

So `SphereSurface.facesLens` keeps the original expression and ignores the normal
it is handed, and a test asserts that passing a deliberately wrong normal changes
nothing on the sphere while changing the answer on a mesh. The tidier version
would have been correct mathematics and a diff in a number this document exists
to hold still.

**Where the reader had to live, and why that is not a detail.** R1 lets `sim` and
`solver` import `calibration` and nothing else, so a loader cannot sit anywhere
either model can reach. A GLB reader is the most plausible-looking thing anyone
would ever want to share across that boundary — pure IO, no geometry, and
duplicating it feels like waste. That is precisely the argument that would be
made for sharing a PRNG, and then a distortion model. So it is its own leaf
package, and `packages/meshio/test/boundary.test.ts` names it so whoever is about
to make the argument finds the answer.

What the reader handles is chosen from what real exporters emit rather than from
what the spec minimally requires: the node hierarchy with transforms accumulated
down the tree, TRS and matrix nodes, instancing, interleaved buffer views,
normalized integer attributes, and non-uniform scale carried through the inverse
transpose. What it refuses — non-triangle primitives, Draco, external buffers,
sparse accessors — it **names in the report** rather than dropping in silence,
because a model that arrives with half its geometry missing has to say so.

**The up axis is the trap.** glTF is Y-up; this repository is Z-up, and the rig,
the floor plane and the polar mask are all written against that. A reader that
skipped the conversion would lay every model on its side, which reads as "the
exporter is odd" rather than as a bug in the reader. The conversion is a rotation
about +X, so it cannot mirror and the winding survives — a mirroring conversion
would turn a closed model inside out and every surface would face away from its
projector, visible as a sphere lit from within.

Its tests build GLB files byte by byte from the specification rather than
checking in an exporter's output: a fixture proves only that the reader agrees
with whatever that one tool wrote, and the cases that break a loader are the ones
a single exporter never produces. The load-bearing check runs bytes all the way
to geometry — a tessellated sphere written as a GLB, read back, built into
`MeshSurface`, and intersected against `raySphereIntersect`.

**How the mesh path is checked.** A ray-triangle intersector is easy to write and
hard to be sure of: a wrong one still renders something, and on an arbitrary
model there is nothing to compare it against. So the tests tessellate a sphere
and hold the mesh against `raySphereIntersect` — an independent implementation of
the same surface — and demand *convergence* rather than a chosen tolerance. Every
tolerance in that file is derived from the chord sag `R(1 − cos(d/2))` rather
than hard-coded, because a tolerance nobody can derive is one that gets loosened
the next time it fails.

That test earned its keep immediately. It found that a ray landing exactly on a
shared edge was rejected by **both** adjacent triangles and fell straight through
the surface — the classic watertightness crack. It is not a rare accident and
that is what makes it serious: a regular tessellation puts its shared edges on
meridians, a rig aimed down an axis fires rays straight at them, and the dropped
ray lands in the same place every frame. A random crack is noise; a crack that
follows the mesh's own seams is a black meridian through the middle of a coverage
map. Closed with a barycentric tolerance, which is a practical fix and not a
proof — **Woop et al. (2013) give a provably crack-free ray-triangle test, and
that is the upgrade if the mesh path ever has to carry a §7-style gate.**

**Three findings about the Phase 0 interface**, which is the sort of thing only a
second implementation can produce:

- `pointAt` is not invertible on a mesh. A UV maps to a point only if some
  triangle's UV triangle contains it; there may be several (UV sets may overlap)
  or none (unwrapped meshes have gaps between islands). It is a search returning
  the first match in triangle order — deterministic, but a choice rather than an
  answer. Callers that sample the surface should use `sampleArea`, which has no
  such ambiguity.
- The content coordinate is still `{ latDeg, lonDeg }` and now carries UV through
  the equirectangular convention `sampleEquirect` already defines. That is not a
  fudge — it means a dome unwrapped equirectangularly shows exactly the content a
  sphere would — but `latDeg`/`lonDeg` are now a transport rather than a
  geographic fact, and Phase 2 should rename them.
- **A ray hit had to carry the face it struck, and originally did not.** The
  interface returned `{ t, point, normal }`, so a consumer needing the triangle
  — for a content coordinate, or for the blend's per-vertex field — had to find
  it again from the point alone. `MeshSurface` did that by shooting a short ray
  from the bounding centre through the point, which is a search assuming a
  **star-shaped** body, not a nearest-triangle query.

  Review raised it as a concavity problem; measuring it found something plainer.
  **A flat wall breaks it completely**, and a wall is the most ordinary
  projection-mapping subject there is: its bounding centre lies *in* its own
  plane, so the radial ray is exactly tangent and finds nothing at every point.
  Before the fix the entire wall reported one content coordinate — a whole
  surface sampling a single texel — and a normal at right angles to itself,
  which makes every facing test and every incidence cosine wrong.

  The information was never missing, only discarded: `intersectBvh` already
  returned the triangle and the barycentrics, and `sampleArea` already chose the
  triangle. `SurfaceHit` and `SurfaceAreaSample` now carry a `SurfaceLocation`,
  and `coordAt`, `normalAt`, `coverageAndWeights` and `sampleSurface` take one.
  The search survives only as the fallback for a point that arrived without a
  face, and its doc now states what it assumes. A true closest-point query over
  the BVH remains the general answer, worth writing the day a caller needs a
  face for a point it did not trace.

**Why the mesh is NOT a field on `RigCalibration` yet.** That is the right
destination and it is not yet the right change. `RigCalibration`'s own contract
says "serialized to JSON, passed between A and B", and a `SurfaceMesh` is typed
arrays: `JSON.stringify` turns a `Float64Array` into an object keyed by
stringified indices, so a 100k-triangle model becomes tens of megabytes of
`{"0":0.123,"1":…}` that reads back as something which is not a mesh. It would
not break the bench today — `bench-results.json` carries no `RigCalibration`;
`inputs.injected` is a perturbation record that merely has a `projectors` key —
but the type's documented contract is the contract, and the solver returns one of
these.

Doing it properly means deciding how a calibration carries a mesh across JSON:
beside it as a `.bin`, or as the source file's own bytes to re-read, as
`packages/calibration/src/mesh.ts` sketches. That is a decision about the boundary
object, and it belongs with Phase 5, where the solver actually needs a mesh to
cross. Until then the surface is passed to `prepareRig`, which gets a model on
screen without putting a landmine in the type both models share.

**Gates, re-measured on the Phase 1 head:** bench still byte-identical to the
pre-refactor baseline (5,563,347 characters), 889 tests pass, `progress:reference:check`
clean, boundary lint clean across 198 files.

*Estimate: 1–2 weeks. Support OBJ second; GLB first is the cheaper 80%.*

### Phase 2 — a mesh on the GPU. **IN PROGRESS**

**The traversal landed, and its parity with the simulator is proven.**
`packages/sim/src/mesh/pack.ts` writes the hierarchy and the triangles into two
`RGBA32F` textures; `harness/src/glsl.ts` gains a `mesh` chunk that traverses
them; `reference.ts` carries the transliteration; and
`harness/test/mesh-parity.test.ts` is link (1) for the mesh.

**Two fixtures, because float32 is part of the answer.** The packed textures are
`Float32Array` — that is what a GPU reads — while `packages/sim` traces in
float64, so a general mesh cannot agree exactly and a test demanding it would be
measuring the rounding. The first fixture therefore uses coordinates exactly
representable in float32, where packing is lossless: **1477 hits over 2000 rays,
every one agreeing on the triangle and on `t` to the last bit.** The second is an
ordinary tessellated sphere, where the departure is measured (worst distance
disagreement under 1e-5 m, fewer than 1% of hits choosing a different triangle at
a shared edge) rather than assumed small.

**The first deep fixture found a real bug, which is what it was for.** The
octahedron builds three nodes and one level — enough to pass and not enough to
mean anything. A crumpled dyadic grid builds 767 nodes and nine levels, and it
failed immediately on a ray with `dir.y` exactly zero. An axis-parallel ray has
an infinite reciprocal on that axis, and a slab plane the origin sits exactly on
gives `0 * Infinity = NaN`. The simulator's box test is `!== Infinity`, which
**admits** a NaN and descends; the obvious transliteration `>= 0` **rejects** it
and prunes a subtree containing geometry — a hole in the model, on exactly the
rays a viewer looking straight down an axis produces. Changing the miss sentinel
from `Infinity` to `-1`, which GLSL forces, silently changed the NaN semantics
with it.

That agreement now depends on NaN propagation, and **GLSL ES 3.0 does not
guarantee NaN behaviour in `min`/`max`**. So it is proven for link (1) and
recorded as a known risk for link (3) in `packages/harness/README.md`, with the
fix that would be applied if a real GPU shows it. Not applied pre-emptively,
because it would move `packages/sim`'s arithmetic to fix a fault nobody has
observed.

**The wiring is done in both shaders, and the blend had to cross first.** A
mesh's weight is not a closed form on the angle from a limb; it is the per-vertex
geodesic field of Phase 3, which `footprintDistanceAt` interpolates across the
face a hit landed on. A shader cannot follow a `Float64Array` any more than it
can follow the hierarchy, so `pack.ts` gained a third texture: three texels per
triangle, one per corner, four channels because a framebuffer holds four
viewports and both shaders declare `MAX_PROJ = 4`. Per corner rather than per
vertex, which is the trade the positions already make — a dependent fetch in the
blend would sit in the same loop the traversal keeps prefetchable.

`surfaceIntersect` is each shader's `Surface.intersect`: one place branches, and
the sphere keeps `raySphereIntersect` with the same arguments in the same order,
which is why the bench did not move. `sampleSurface` (harness) and `shadeTwoRig`
(app) take the HIT rather than a bare point, for the reason `SurfaceLocation`
exists on the CPU — a mesh's normal and content coordinate belong to the face
that was struck. The app's content rig takes its second intersection against the
same model, since a misregistration is a disagreement about where the lenses are
and not about what shape is standing in the room. `pickMarker` occludes against
the model too: a marker behind a building is not clickable.

**A sphere cannot exercise the shadow test**, which is worth recording because it
cost a fixture. Removing the shadow ray from the reference left a tessellated
sphere pixel-identical — a convex body cannot get in its own way — so the mesh
parity check carries a second fixture of two plates, where 86 samples face a lens
and are dark anyway.

**The page now hands the display shader a model, and the gate that held it back
is met.** `parity.ts` says what its verdict means on one: the allowance is sized
against the real driver's own read-backs rather than against a sphere's
silhouette, and the denominator no longer counts pixels no projector reaches. See
`packages/web/src/parity.ts` and the note at the top of this document.

**What the wiring cost, recorded because the estimate did not include it.** Four
edits were foreseeable — one shared surface for both rigs, a two-level memo since
`draw()` runs per frame, a catch for `packMesh`'s refusal (which reached
`frame()`, called `fatal()` and stopped re-arming `requestAnimationFrame`, so a
model one level too deep froze the page), and the same model in `checkParity`. A
fifth was not: the worker's parity render had to follow the model too, or the
number on screen compares a picture of a building against a picture of a sphere.
And a sixth was invisible to every test in the repo — dropping a file marked
nothing dirty, so `draw()` never re-ran and the live view kept showing a sphere
while the model card showed the model. All 978 tests, four gates and two mutation
checks passed on that. The smoke assertion is what caught it.

The reason recorded here for that gate — that "a mesh has one silhouette per
triangle, and about 1% of hits at a shared edge pick a different face in float32
than in float64" — was refuted, and is corrected rather than quietly dropped.
`packages/harness/README.md` records the retraction; re-counted on the fixture
the sentence is about, **0 of 4212 primary hits lie within 1e-7 of a triangle
edge**, which is the scale at which float32 perturbs a barycentric coordinate.
The gate was real. This was never its mechanism, and it survived two review
rounds on plausibility because nobody counted the population it needed.

**A baked SDF is the tempting shortcut and it is the wrong one.** The shader
already ray-marches SDFs for furniture, so it would be quick — but the parity
check compares GPU pixels against CPU pixels, and an SDF surface differs from the
exact triangle surface by up to a voxel. Parity would stop measuring renderer
agreement and start measuring the voxel grid, and the number on the page would
quietly become meaningless. If the SDF path is taken anyway, it must be taken
deliberately, with `parity.ts` re-derived to say what it now measures.

*Estimate: 1–2 weeks, plus whatever the parity tolerance re-derivation costs.*

### Phase 3 — projection mapping proper. **IN PROGRESS, out of order**

**Taken before Phase 2, deliberately.** The phases are numbered by dependency and
this one does not depend on Phase 2: the blend and the warp are computed on the
CPU from a surface intersection, and putting a mesh in the fragment shader would
not change a digit of either. Ordering them 2-then-3 was an assumption that the
GPU comes first because it is what you see. It does not: Phase 2 makes the live
view stop lying about the shape, Phase 3 makes the output loadable by a player,
and only the second one is on the path to something you could take to a wall. The
numbers are identities — commits and tests refer to them — so they are not
renumbered; only the order changed.

**The footprint blend LANDED, and it is not the algorithm this section
prescribed.** The original text said screen-space distance transform. That was
wrong for a reason the arithmetic states plainly, recorded in the tier list above
and measured before being discarded: `w_width` is an angle on the *surface*, a
screen-space field measures angle at the *lens*, and near a limb — where the ramp
lives — those diverge until the ramp is wider than the footprint it ramps across.
Built, measured at **0.46** of a normalized weight away from the closed form, and
deleted.

What replaced it is the same distance measured along the surface:
`packages/sim/src/footprint.ts` runs a multi-source Dijkstra over welded mesh
edges from every vertex the projector does *not* light, so the field is the
geodesic distance inward from the edge of that projector's footprint. The
acceptance test is that it degenerates to the sphere's closed form, and it does so
algebraically rather than approximately — on a sphere the footprint is a cap
bounded at `theta_max`, so the surface distance to its edge is
`R(theta_max − theta)` and dividing by the width as an arc gives
`(theta_max − theta)/w`, which is the closed form identically. Measured departure:
0.093 at 96×48, 0.0099 at 192×96, 0.0099 again at 384×192 — it converges and then
stops, because a path constrained to mesh edges is a few percent longer than one
free to cut across faces. Fast marching would remove that residue for a
per-triangle eikonal solve.

The general form subsumes more than the sphere's did. The sphere's ramp has one
kind of edge, the limb; a mesh footprint has three — the raster edge, the
terminator, and a shadow edge — and all three are edges of one set, the points
`isIlluminatedAt` says the projector lights. So a shadow edge feathers exactly
like a raster edge, and two projectors crossfade across the shadow a model casts
on itself. No sphere has ever needed that.

**The warp-and-blend export LANDED.** `packages/sim/src/warp.ts` writes Paul
Bourke's warp-mesh format — the one dome and planetarium players read directly.
Per node of a projector's raster: send the pixel out through the rig, find where
it lands, and write which texel belongs there and how brightly. It is the
projection-mapping deliverable, and it is worth being explicit that it is a
*different computation* from the `warpMeshes` already in
`packages/web/src/model.ts`, which measures the disagreement between two
calibrations (two rigs in, a displacement out). This takes one rig — the true
one, or a recovered one — and writes the correction (one rig in, a texel and an
intensity out).

Bourke's format was chosen over MPCDI because its fifth field is an intensity
multiplier, so **warp and blend leave in one file**. A geometry-only format would
need the blend shipped beside it in something else, and the two would drift.
MPCDI is the right second target and costs a ZIP writer and a PFM writer to say
what this says in twelve lines.

Two conventions flip between this repository and the format, and neither
announces itself when wrong — each produces a picture that is plainly a picture,
just upside down or mirrored, which reads as a bad model export rather than as a
bug here. Raster `v` runs down and display `y` runs up; equirectangular `v` runs
down from the north pole and texture `v` runs up. Both are pinned against a
hand-computed node rather than against a comment.

Two decisions inside the format matter more than they look, and both were got
wrong first.

**A node with no data is marked BOTH ways.** The format defines two markers:
"values outside the 0 to 1 range indicate that the node is not to be used", of
texture coordinates, and "negative values indicate that the node should not be
drawn", of intensity. This wrote `0 0 -1`, on the second rule alone — and `0 0`
is a perfectly valid texel, so a player applying only the first rule draws the
node, at the corner of the image. It now writes `-1 -1 -1`, which is outside
[0, 1] on both texture axes and negative in intensity, and costs nothing. Either
way it is not a zero intensity: a zero is a black pixel the projector still emits
its black floor into, which is the rectangle of glow around every real
installation.

**`x` spans ±the aspect ratio, and only `y` spans ±1.** The format's own words
are "the horizontal range (x) will be +- the aspect ratio and the vertical range
(y) will be +- 1". Normalizing both axes to [-1, 1] is the obvious thing to write
and it squeezes every non-square projector, which is every real projector: a
1920×1080 raster comes back as 16:9 of content crammed into a square, and a
compliant player shows it that way. Nothing about the file looks wrong, which is
how that survives being looked at. `pixelAspect` belongs in the ratio, because
the format's number is about the displayed rectangle and a non-square pixel makes
that a different shape from the raster's own ratio.

**A test premise, not the code, was wrong once here.** The polar mask looked
absent from the sphere's export until the export was interrogated: at a 31×31
grid the deepest node reaches latitude −65.5°, above the −70° full-mask
threshold, so "find a fully masked node" finds nothing while the mask is working
correctly (0.3394 where the mask value is 0.422). The test now compares each
export against *its own* blend weight, which is a decision about the mask rather
than a search for a magic number.

**The polar mask is REFUSED BY DESIGN, which closes Phase 3.** This document
proposed generalizing it to a painted mask in surface UV. That was wrong, and it
is worth saying why rather than quietly dropping it.

The mask attenuates a sphere's exposed south cap, keyed on **absolute latitude**.
The north cap needs no software mask because a ceiling mount physically occludes
it — that asymmetry is the whole content of `bottomOnly`, and `coverage.ts` states
it. A dropped model has neither a pole nor a cap, and its `latDeg` is a UV
coordinate wearing a latitude's name, so a mask applied there would darken a band
of texture rows chosen by whoever did the unwrap. That is a picture of a
parameter, not of anything physical.

Unlike the blend, there is no general form to find. The blend's `theta_max`
turned out to BE "distance inward from where this projector's light stops", which
generalizes; the mask's latitude is not a disguised general quantity, it is a
fact about one shape.

**What the mask stands in for is an occluder**, and that is the real
generalization — a different and more useful feature than a UV mask. It does not
exist today, and it is worth being precise about how completely it does not:

- `Surface.shadowed(point, lens)` answers only whether a surface occludes
  ITSELF. `SphereSurface` returns `false` unconditionally; `MeshSurface`
  traverses its own hierarchy. Nothing else in `isIlluminatedAt` can block a ray.
- The room's furniture — projector bodies, guard rail, suspension rod — is drawn
  and does not occlude. `web/src/glsl.ts` says so in those words: "none of it
  occludes the light, and the trace below is not told it exists."

So the ceiling mount is a real physical occluder that this model carries as a
PARAMETER rather than as geometry. A scene-occluder feature would let the two be
the same thing — and immediately runs into the byte-identity gate, because
putting the mount in as geometry would move every number in
`bench-results.json`. Such a feature must therefore be **additive and empty by
default**: occluders for models, the sphere's mask exactly where it is, and
reconciling them a deliberate re-baselining rather than a side effect.

It is also an interface change rather than a local one. Occlusion currently lives
ON the surface, and a separate object does not fit there — the question moves up
from "does the surface block this ray" to "does anything in the scene block it",
which `isIlluminatedAt` would have to be handed. Small next to Phase 5, but the
same shape of change.

*Estimate: closed. The blend, the export and this decision are Phase 3.*

### Phase 4 — projectors anywhere. **LANDED**

**The model side landed.** `packages/sim/src/placement.ts` builds a rig from
explicit placements: any count, any arrangement, each projector framed from its
own throw, laid out as viewports of one framebuffer by `gridViewports`.

**A second builder rather than more parameters on `nominalRig`.** The nominal
rig's azimuth slots, its cap of four and its always-2×2 framebuffer are not
limitations to relax — they *are* PARAMETERS.md, and every scored number in
`bench-results.json` is a statement about that rig. Widening it until it could
also express an arbitrary rig would leave nothing naming the installation the
gates are about. The two meet at one assertion: `placedRig` handed the nominal
geometry must reproduce `nominalRig()` field for field, because a generalization
that cannot express the case it generalizes is not one.

**`assertFramebufferTopology` needed no relaxation, and this document was wrong
to say it would.** The check is per-viewport — each viewport times the
framebuffer equals that projector's raster, and lies inside it — which is as
true of six projectors in a 3×2 grid as of the SOS quadrants. Only its error
*message* named the 2×2 split. What generalizes is the framebuffer layout;
what stays is the invariant, and the single framebuffer itself: §3.4 discusses
and rejects the multi-window shape, so six projectors on a wall are still one
framebuffer split six ways.

**Two things the implementation forced.**

`aimAtSphereCenter` could not be rewritten in terms of the general
`aimAtPoint`, and the reason is the sphere's arithmetic again. The first negates
the position, the second subtracts it from the target; for every non-zero
component those are bit-identical, but an exactly-zero component comes out `-0`
one way and `+0` the other, and both `atan2` and `asin` read that sign. Every
nominal lens sits at the sphere's own height, so **all four carry `pitchDeg:
-0`** where the general form gives `+0`. Measured, not argued — and then measured
again to show it is inert: the two rigs produce bit-identical rays at 60 pixels
per projector and bit-identical coverage weights over a 408-point grid. The
functions stay separate anyway, because `bench-results.json` is byte-compared
and the nominal rig is what produces it.

`isRing` — which decides whether the sector blend's assumption holds — was
written against radius and height, and that tests for a **cylinder**. Three
projectors on one wall sat within 7% of the mean radius at identical height and
passed as a ring while occupying 44° of arc. A ring also requires the lenses to
go most of the way *round*: no gap between neighbouring azimuths wider than half
the circle. That admits the spec's own N=3 rig (widest gap exactly 180° where a
quadrant went dark) and rejects two lenses 90° apart, which A-06 already says is
not an installation anybody would build.

**The panel landed, under the dropped model rather than beside the install
controls.** That placement is the whole design decision. The install controls
describe the SOS sphere and refuse a fifth projector in so many words — §3.4's
framebuffer has four quadrants and §2 supports 2, 3 and 4 — and **that refusal is
still right**, because every §7 gate on this page is a number about that machine.
A six-projector rig answering them would be a score for an installation nobody
described.

So a hand-placed rig reaches only the surface request, whose three numbers are
counts over the model's own area and stay true whatever is pointing at it. It is
the same argument that made the surface a separate worker request in Phase 1,
applied to the rig instead of the shape. The four-projector chip row keeps its
cap and its explanation; the explanation now says where the limit *isn't*.

`tools/smoke-app.ts` drives it end to end, and the second half of that check is
the one that matters: five hand-placed projectors light the fixture 100%, which
is also what four would report, so the test then strips the rig to a single
projector and requires the number to fall. It reports 50.0% — exactly half an
octahedron's faces — which proves the placements are being *used* rather than
merely delivered.

*Estimate: ~1 week. Landed.*

### Phase 5 — the solve

**LANDED so far:** mesh intersection in `packages/solver`, written independently
of the simulator's and shown to agree with it bit-exactly in
`packages/bench/test/mesh-agreement.test.ts` — the first sim-vs-solver geometry
test in the repository, for any shape. Plus the mesh hit Jacobian, and a
central-difference test under the loop that assembles the normal equations,
which had none.

**LANDED since:** the mesh IS in the bundle. `BundleOptions.surface` is resolved
once in `buildProblem` and selected in `hitAtEpoch`, so both correspondence
epochs trace it; `bootstrap` threads it through every rung, with rungs 0 and 2
going via one `surfaceHit` helper and rungs 1 and 3 inheriting it through
`runBundle`; and `gaugeUnobserved` now measures the model's own null space rather
than assuming the sphere's. `mesh-bundle.test.ts` asserts recovery with a
negative control, and the sphere path is byte-identical across the
twelve-scenario baseline.

**The page can now do it, and running it found two things no test had.**
`CaptureOptions.surface` reaches `prepareRig`, the mesh crosses the worker
boundary as `SolveRequest.mesh`, and the bundle gets it as `bundle.surface`. A
tri-axial body (1 : 0.7 : 0.5) at the rig's own radius recovers to **14.3 /
13.1 / 8.8 mm** across three noise seeds on the page's configuration, where the
analytic sphere gets 17.3 / 15.9 / 8.0.

Neither of the two defects was visible to the test suite, and both were found by
running the thing rather than asserting about it:

- **The sphere segmenter refused every mesh.** `sphereSegmenter` fits a CIRCLE
  and rejects what falls outside it, which is sound for the one body whose
  silhouette is a circle from every angle. On a mesh it refused 3 of 3 cameras
  and decoded ZERO correspondences — and not only on a strong deformation: a
  body squashed five per cent was refused just as completely. It is now off
  whenever a surface is supplied. A mesh therefore gets no protection from room
  spill, which wants a segmenter taking the model's own silhouette.
- **A solve with no data reported a confident answer.** With every camera
  refused, `runSolve` returned `converged: true`, a residual of 0.0000 px and a
  worst-lens error of 266.951 mm — the untouched bootstrap's own distance from
  truth, dressed as a result. An empty decode now throws, naming the control
  that caused it.

**Retracted: the near-sphere numbers this section used to carry.** An earlier
version of this paragraph reported 259.3 mm at 1 : 0.95 : 0.9, 24.0 mm at
1 : 0.7 : 0.5, and 83.9 mm with `dataTolerance` raised to 1e-3, and drew a
gauge-tolerance trade-off from them. Every one of those solves was run on a
mesh of radius 1.651 m — the SOS sphere from the solver tests — on a rig whose
sphere is 0.864 m, so each was 1.9× the rig with cameras placed for the smaller
ball. They measured the wrong object. The tolerance trade-off drawn from them
does not exist: at the rig's own radius every spheroid pins its azimuth at the
same angle as the analytic sphere, every tri-axial frees it, and `dataTolerance`
decides correctly with the value it ships with. The corrected sweep is below:
first what it found before any accuracy number could be trusted, then the table.

**A spheroid mesh converges and cannot tell, so the page refused it.** The
sweep's first finding was not about accuracy at all. On the page's own
configuration — three cameras at 320×240, sensor noise on — every spheroid mesh
ran to the 400-iteration cap (two passes of 200: the initial fit and the
rejection refit both), took four to six minutes, and was then refused by the
page as "did NOT converge". The trajectory of one such solve, a 192×384
tessellated sphere on seed 1:

```
accepted step    cost         residual px
   1             8.0152e+4    1.647
  26             5.8513e+4    1.407      <- converged
  51 … 200       5.8513e+4    1.407      <- flat to five figures, 174 more steps
 201             5.4365e+4    1.357      <- rejection pass refits
 226 … 400       5.4360e+4    1.357      <- flat again to the cap
last-half improvement: 0.009%
```

Its worst lens was **12.5 mm** from truth — better than the analytic sphere's
17.3 on the same seed — and the page threw it away after 338 seconds.

The three stopping rules (`costTol` 1e-12 relative on two consecutive steps,
`stepTol` and `gradTol` 1e-9 px) assume what a sphere gives: a smooth residual
whose Gauss-Newton descent is quadratic near the minimum, so cost, step and
gradient fall to machine precision together. A triangle mesh is C⁰. Its hit
Jacobian is exact within a facet and jumps at every edge — the property Phase 5
recorded and left as "the empirical question it is" — so a step that crosses one
lands on a different tangent plane, the gradient reappears, and the cost jitters
at a level that never falls under 1e-12 twice running. Measured on that plateau,
per accepted step: minimum 7.6e-13, median 2.8e-11, maximum 4.3e-9 relative —
the tolerance sits below the minimum, so the rule that needs it twice running
cannot fire. The tri-axial rows of the sweep below show the jitter alone is not
what stalls a solve: with every direction well determined the optimiser settles
inside a facet and the original rules fire in 24 to 43 steps. It is the bodies
with a symmetry axis — every spheroid, however far from a sphere — that never
settle.

`BundleOptions.meshPlateauWindow` / `meshPlateauTol` add a fourth rule on the
mesh path only: stop when the relative cost change across a window of freely
accepted steps (damping at or below `initialLambda`, the same stall guard the
two-in-a-row rule encodes) is below the tolerance — 1e-6 over ten steps, which
is 23× above the worst plateau spike (10 × 4.3e-9) and four orders below the
descent phase's ≥1e-2, so it fires on the plateau and cannot fire before it.
Gated on `surface !== null`, so the sphere path does not evaluate it; the
twelve-scenario baseline confirms that gate to the last bit. With it, the same
192×384 solve stops at accepted step 49 in 65 seconds at the same 12.5 mm, and
the page installs it; the 64×128 solve stops at step 80 in 56 seconds at
137.5 mm against 137.4 at the cap — which is the point: the rule changes when
the optimiser stops, and nothing about where. Confirmed afterwards on the whole
thirty-row sweep below, re-run with the rule on: every row converged and was
installed, in 24 to 80 steps and 29 to 86 seconds each — 23 minutes for the
table, where one capped row alone took four to six — with correspondence counts
and gauge angles identical on every row and the error identical to 0.1 mm on
all thirty. Two rows took MORE total steps than before (69 to 77, 35 to 36):
ending the first pass earlier hands the rejection pass a different starting
point, and it takes its own route to the same answer.

**The corrected sweep.** Ten shapes × three seeds on the page's own configuration
(three cameras at 320×240, sensor noise on, `errorSeed` 1–3), every mesh at the
rig's radius of 0.864 m and tessellated 64×128, run on the solver as it stood
before the plateau rule so that the iteration column shows the defect. Worst
lens position error in mm; bold marks a solve that ran to the 400-iteration cap
(two passes of 200). Gauge: pinned means the stiffness test found an
unobservable direction and froze it, free means it found none.

| shape | seed 1 | seed 2 | seed 3 | gauge | iterations |
|---|---|---|---|---|---|
| *analytic sphere* | 17.3 | 15.9 | 8.0 | pinned | 42 / 43 / 22 |
| sphere mesh 1:1:1 | **137.4** | 32.2 | **33.4** | pinned | 400 / 69 / 400 |
| oblate 1:1:0.98 | **80.1** | **51.5** | **34.6** | pinned | 400 / 400 / 400 |
| oblate 1:1:0.95 | **38.5** | **37.1** | **30.8** | pinned | 400 / 400 / 400 |
| oblate 1:1:0.9 | **27.7** | **20.6** | **20.3** | pinned | 400 / 400 / 400 |
| oblate 1:1:0.8 | **16.8** | **12.3** | **11.2** | pinned | 400 / 400 / 400 |
| oblate 1:1:0.7 | **15.6** | **12.9** | 10.9 | pinned | 400 / 400 / 240 |
| tri 1:0.95:0.9 | 11.8 | 12.6 | 8.4 | free | 27 / 28 / 29 |
| tri 1:0.9:0.8 | 12.0 | 11.3 | 11.1 | free | 24 / 24 / 41 |
| tri 1:0.8:0.6 | 12.2 | 13.2 | 9.7 | free | 24 / 24 / 43 |
| tri 1:0.7:0.5 | 14.3 | 13.1 | 8.8 | free | 33 / 35 / 33 |

Three things the table says, none of which the retracted numbers did. **Every
tri-axial matches the analytic sphere** — 8.4 to 14.3 mm against 8.0 to 17.3 —
and stops under the original rules in 24 to 43 steps, while sixteen of the
eighteen spheroid rows ran to the cap, so the plateau stall goes with a symmetry
axis, not with the mesh. **Every spheroid pins and every tri-axial frees**, and
the pinned angle is the analytic sphere's own to two thousandths of a degree on
each seed (0.324 / 0.277 / 0.117), so the gauge decides correctly at the
shipped tolerance on all thirty rows; the trade-off the wrong-radius solves
showed was the wrong object, not the gauge. **The accuracy gap is a function of
how nearly spherical the body is**: the tessellated sphere 32 to 137 mm,
1 : 1 : 0.98 at 35 to 80, 1 : 1 : 0.95 at 31 to 39, 1 : 1 : 0.9 at 20 to 28,
and from 1 : 1 : 0.8 on (11 to 17) the spheroids sit inside the analytic
sphere's own range — while still running to the cap, so the stall and the gap
are two effects, not one.

**What this does not fix, and is recorded as the next measurement.** A nearly
spherical mesh is less accurate than the sphere it approximates — the tessellated
sphere at 32 to 137 mm against the same body's analytic 8 to 17 is the cleanest
comparison in the table, since it changes the representation and nothing else —
and finer tessellation helps but not monotonically (seed 1: 137.4 mm at 64×128,
12.5 at 192×384, 23.6 at 384×768), which is the signature of noise rather than
bias. The reading that fits all thirty rows: a flat facet normal is the
derivative of the facet, not of the surface the facets approximate, so every
step carries a Jacobian error that changes at each facet edge. Where the data
determines every direction — a tri-axial — the optimiser rejects it, settles
inside a facet and converges in the ordinary way. Where one direction is exactly
null and held only by the gauge's soft prior — every spheroid — the optimiser
keeps wandering across facet edges and never satisfies rules built for a smooth
descent, which is the stall; it costs nothing while the other directions are
stiff (1 : 1 : 0.8 and 1 : 1 : 0.7 are as accurate as the analytic sphere).
Where the remaining orientation is itself weakly determined — a flattening of a
few per cent, or none — the wandering carries error into it, which is the gap.
Which directions carry the error has not been measured; this is the reading,
not the proof. The principled fix is a smooth Jacobian — interpolated vertex
normals, so the derivative describes the curve the tessellation is standing in
for — which Phase 5 chose against ("a smoothed one describes a curve the
tessellation does not have") and which would mean the Jacobian no longer
differentiates exactly what the residual computes, the property its tests
assert. The tessellated sphere is the fixture for it: if smooth normals take
32 to 137 mm to the analytic 8 to 17 on the same seeds, the reading above is
confirmed, and if they do not the gap is somewhere else. This stopping rule
makes the mesh path usable; that experiment is what would make it accurate.

**Rung 1's single radius is CLOSED, measured rather than argued.** The item read
"a rung 1 that does not collapse the search onto a single radius", on the
hypothesis that placing every projector at one distance along its nominal bearing
needs a centrally symmetric object. A fixture was built to violate both halves at
once, well past anything a real site produces: distances spread 4.41 to 6.45 m —
wider than §2's whole 5.0-6.5 m prior, which is the range the sweep searches —
and bearings swung 15 to 35 degrees off §2's 0/90/180/270, against its stated
1-2 degree mount tolerance, on the tri-axial body the hypothesis was about.

The sweep picks one distance and it is wrong for every projector: 5.00 m against
truths of 4.41, 5.16, 5.83 and 6.45. The per-projector distances come back
anyway — 4.41 / 5.13 / 5.85 / 6.44 — the bootstrap's own error is unmoved at
31.8 mm against 30.6 mm on an on-nominal rig, and the solve recovers to
1.4e-10 mm. The shared radius is where rung 1 STARTS its camera-only fit, not a
constraint it imposes on the answer. The test asserts the sweep's answer is wrong
for every projector, so a future per-projector rung 1 has to re-measure rather
than silently inherit the claim, and reverting the gauge fix takes the same
fixture to 1669.6 mm, so it is not a test that cannot fail.

**Why it does not bind is structural, not lucky, and that is what closes the
item.** The shared radius is the STARTING PLACEMENT of each sweep trial; the
trial then runs an LM with `projectorPose` free, which moves every projector
independently. The collapse is undone inside the rung that creates it. A rung 1b
was written to remove it anyway — a per-projector radial line search over a
geometric bracket spanning 3.25 to 7.70 m from a 5.00 m pick — and then reverted:
instrumented on the fixture above it fired on all four projectors and moved none
of them, because they were already at 4.415 / 5.126 / 5.846 / 6.439 m against
truths of 4.41 / 5.16 / 5.83 / 6.45. The sweep's own answer is wrong and does not
matter for the same reason: three seeds chose 5.00, 5.25 and 6.00 m and all three
recovered to about 1e-10 mm. A per-projector rung 1 is a search with nothing to
find, so shipping one would add surface area for no measured effect.

It does NOT attribute the recovery, and one mutation is worth recording because
it refuses to. `initialize.ts` says rung 2's DLT is "what makes the bootstrap
robust to a rig that is not laid out the way §2 says". Mutating rung 2 to offer
no alternative candidate at all — no footprint, no DLT, so a projector can only
ever be the one it started as — leaves this fixture passing. The short LM settle
inside rung 2, and the full solve after it, are doing the work here. The DLT's
own claim still has no fixture.

**Still to do:** the measured gauge null space is DONE, see the gauge bullet
above. New
scenarios and new gates, which cannot be a port: §7's numbers are sphere
theorems and nobody has measured a mesh installation. And an honest statement of
which photometric numbers remain PROVISIONAL — all of them, for the same reason.

**No longer in scope:** model pose and scale in the bundle. Pose is held; see the
pose bullet above.

Two traps to clear before any mesh scenario enters the CI corpus, neither of them
obvious from the plan: gate waivers are keyed by gate id alone, so a mesh corpus
reusing `pose_position` would silently inherit A-18's 640 mm ceiling; and a
crashed solve voids ALL metrics, turning gates NOT-MEASURED, which the waiver
machinery deliberately refuses to waive — while a mesh bootstrap failing is the
expected early outcome.

*Estimate: 1–3 months, and the bootstrap is genuinely research.*

## Totals

| Scope | Estimate |
| --- | --- |
| Q1 + Q2 — mesh renderer and projection-mapping output (Phases 0–4) | **5–8 weeks** |
| Q3 — the calibrated loop on an arbitrary mesh (Phase 5) | **+1–3 months** |

## So: could it support arbitrary projection mapping?

Yes, and it is closer than the sphere framing suggests, because the warp mesh —
the thing a projection-mapping product actually ships — is derived from nothing
but a surface intersection, and that intersection is now behind an interface a
mesh implements. Phase 3 turned the claim into a file: `buildWarpExport` writes
warp and blend together in a format a dome player loads. Note the correction the
work forced on this paragraph, though — what was "already built" when this was
written was `warpMeshes`, which measures how wrong a config file is. The
*correction* had to be written; it is a short path from the same trace, but it is
not the same computation.

What Phases 0–4 would *not* buy is any way to know the result is right. On the
sphere, that is the entire point of the repository: the solver recovers a
calibration, the bench scores it against ground truth the solver never saw, and
the gates say whether it is good enough. Ship the renderer without Phase 5 and it
is a good projection-mapping previewer with an honest boundary around what it
claims — which is a fine thing to ship, as long as the page says so.
