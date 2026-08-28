# Arbitrary shapes: a feasibility study

**Status: STUDY, with Phase 0 landed.** Phases 1–5 are unimplemented. This document answers a
question — how hard would it be to let a user drop in a GLB or an OBJ, put the
projectors wherever they like, and get real projection mapping out — and proposes
a plan. It changes no constant, no gate and no line of code.

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
  distance to the model's bounding sphere or to the aim point.
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
  The general form, and what projection-mapping software actually does, is a
  **screen-space distance to the footprint edge**: rasterize each projector's
  footprint on the surface, distance-transform it, ramp on that. It is a
  different algorithm — and it must degenerate to the current one on a sphere,
  which is the acceptance test that keeps it honest.
- **Self-occlusion.** A sphere is convex, so `dot(normal, lens − point) > 0` plus
  a raster-bounds test *is* the visibility test, and `isIlluminatedAt` is
  complete as written. A mesh is not convex. Every point needs a real shadow ray
  per projector. This is physics the sphere version never needed, and it is
  precisely what makes projection mapping interesting: concavities only one
  projector can reach, hard shadows cast by the object onto itself, and coverage
  holes that are nowhere near a pole.
- **The polar mask.** `set bottommask 60,70` is a fact about a sphere hanging
  from a ceiling mount that occludes its north cap. On a mesh it means nothing.
  Either drop it or generalize it to a painted mask in surface UV — which is what
  an operator would want anyway.
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
  handed** rather than assume one. `gauge.nullTolerance` already does exactly
  this kind of measurement — it detects when floor references make tilt
  observable — so this is a widening of an existing idea rather than a new one.
- **The model's pose becomes unknown.** Today the world origin *is* the sphere
  centre (conventions.ts §W) and the radius is class DOC, and between them
  translation and scale are pinned. Hand the solver a GLB and where the object
  sits and how big it is are solve variables: six more parameters, seven with
  scale. Well-posed, and the classic projection-mapping calibration problem — but
  new columns in the Jacobian and a new source of ill-conditioning.
- **Bootstrap breaks, and this is the hardest single piece.** `initialize.ts`
  reaches a convergent basin partly because a sphere's silhouette is a circle
  from every viewpoint. A mesh's is not. The replacement is PnP from clicked
  correspondences, a marker pass, or a coarse pose search — all of which are
  standard, and none of which is a small change.

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

### Phase 1 — a mesh on the CPU

Mesh data type in `packages/calibration` (arrays only). GLB reader — binary
glTF, a JSON chunk and typed-array accessors, and much easier than OBJ, which
needs a text parser and carries no canonical normals or UVs. BVH and ray-triangle
in `packages/sim`. Shadow rays for self-occlusion. Area-weighted triangle
sampling to replace the Fibonacci lattice on the mesh path. `renderRoomView`
draws a mesh.

*Estimate: 1–2 weeks. Support OBJ second; GLB first is the cheaper 80%.*

### Phase 2 — a mesh on the GPU

Pack the BVH into textures and traverse it in the fragment shader, on both the
physical and the content rig. Update `harness/src/glsl.ts` and its
transliteration in step.

**A baked SDF is the tempting shortcut and it is the wrong one.** The shader
already ray-marches SDFs for furniture, so it would be quick — but the parity
check compares GPU pixels against CPU pixels, and an SDF surface differs from the
exact triangle surface by up to a voxel. Parity would stop measuring renderer
agreement and start measuring the voxel grid, and the number on the page would
quietly become meaningless. If the SDF path is taken anyway, it must be taken
deliberately, with `parity.ts` re-derived to say what it now measures.

*Estimate: 1–2 weeks, plus whatever the parity tolerance re-derivation costs.*

### Phase 3 — projection mapping proper

Screen-space footprint blend, replacing the limb ramp, with the sphere case
pinned as a regression. Mask in surface UV. Warp-mesh export in a standard
interchange form. The warp computation itself already exists.

*Estimate: 1–2 weeks.*

### Phase 4 — projectors anywhere

Free six-degree-of-freedom placement in the panel — numeric XYZ and yaw/pitch/roll
per projector, or a viewport gizmo — dropping the quadrant-azimuth constraint and
the four-projector cap. Generalize the framebuffer layout beyond the 2×2 SOS
split, which means `assertFramebufferTopology` needs a second reading rather than
a relaxation.

*Estimate: ~1 week. Cheap, because `ProjectorPose` is already 6-DOF; this is a
UI and a validation change, not a geometry change.*

### Phase 5 — the solve

Mesh intersection in `packages/solver`, written independently of the simulator's.
Model pose and scale in the bundle. Measured rather than assumed gauge null space.
A new bootstrap. New scenarios, new gates, and an honest statement of which
photometric numbers remain PROVISIONAL — all of them, since nothing about a
visitor's mesh has been measured either.

*Estimate: 1–3 months, and the bootstrap is genuinely research.*

## Totals

| Scope | Estimate |
| --- | --- |
| Q1 + Q2 — mesh renderer and projection-mapping output (Phases 0–4) | **5–8 weeks** |
| Q3 — the calibrated loop on an arbitrary mesh (Phase 5) | **+1–3 months** |

## So: could it support arbitrary projection mapping?

Yes, and it is closer than the sphere framing suggests, because the warp mesh —
the thing a projection-mapping product actually ships — is already built and is
already derived from nothing but a surface intersection.

What Phases 0–4 would *not* buy is any way to know the result is right. On the
sphere, that is the entire point of the repository: the solver recovers a
calibration, the bench scores it against ground truth the solver never saw, and
the gates say whether it is good enough. Ship the renderer without Phase 5 and it
is a good projection-mapping previewer with an honest boundary around what it
claims — which is a fine thing to ship, as long as the page says so.
