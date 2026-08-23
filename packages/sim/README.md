# packages/sim — the forward model (A)

**Input:** an equirectangular image plus a `RigCalibration`.
**Output:** a simulated view of the sphere in a room, plus metrics.

Ray-traces projector pixel → sphere surface with **its own** geometry math.

## The duplication in here is deliberate. Do not refactor it away.

`packages/solver` contains code that looks like a near-copy of parts of this
package: a projection model, a distortion model, sphere intersection, pose
composition. It is not a copy. It is an independent implementation of the same
documented conventions (`packages/calibration/src/conventions.ts`), written to
be wrong in different ways.

If you extract the common parts into a shared module — and it will be tempting,
because the two implementations agree to eight decimal places when both are
correct — you destroy the entire project. Here is the mechanism:

- The bench scores the solver by injecting a known misalignment into a
  simulated rig, running the solver on simulated camera images, and comparing
  the recovered calibration against ground truth the simulator already knows.
- If both sides share the projection math, that comparison no longer tests
  whether the solver recovers *reality*. It tests whether the solver can invert
  a function using the same function. It will pass at machine precision while
  the model is arbitrarily wrong about actual physics.
- The score becomes a tautology, and every claim built on it — every gate in
  PARAMETERS.md §7, every experiment result, every "our alignment is more
  accurate than yours" — becomes unfalsifiable.

CI enforces this. `npm run lint:boundary` fails the build on any import between
`packages/sim` and `packages/solver`, in either direction, static or dynamic.

## What lives here

| Module | Responsibility |
| --- | --- |
| `geometry.ts` | World/sphere frames, ray-sphere intersection, pose composition |
| `optics.ts` | Projector frustum, lens shift, distortion inversion (pixel → ray) |
| `coverage.ts` | Coverage field, overlap multiplicity, polar mask, blend-region geometry |
| `blend.ts` | conventions.ts §B: the four ramp shapes, `rampGamma` on the weight, normalization |
| `photometry.ts` | Per-channel transfer (§P), the twelve gammas/floors/gains, black-floor closed forms |
| `color.ts` | Linear RGB → XYZ → Lab, ΔE2000, the Planckian locus and ambient tint |
| `shading.ts` | `ShadingModel`, Lambertian (`lambertian-v1`) and full GGX (`full-v1`) |
| `render.ts` | Deterministic CPU ray tracer: room view, projector views, equirect maps |
| `metrics/` | Geometric and photometric metrics, each scored against its gate |
| `scene.ts` | Rig construction from parameters, misalignment injection |

## Determinism

Every render is a pure function of `(calibration, scene, seed)`. No wall-clock,
no unseeded randomness, no floating-point reduction whose order depends on
scheduling. The headless bench relies on this: two runs with the same seed must
produce byte-identical PNGs.

## Geometry facts this package must reproduce

From PARAMETERS.md §4.2 and §4.3, and asserted in `test/coverage.test.ts`:

- Overlap multiplicity is **1 or 2 wherever anything is lit**, never 3 or 4.
  It is 0 in the unlit polar region the next bullet describes — the claim is
  about how many projectors can reach a point, not about whether any can.
- The unlit polar region is **four-lobed and scalloped**, not a circular cap —
  reaching 80.4° latitude along a projector meridian but only 76.3° in the seam
  directions, at `d_proj` = 5.18 m.
- The output primitive is **one framebuffer split into four quadrant
  viewports**, not four independent outputs.

If a change makes any of these false, the change is wrong, not the assertion.

## The blend region is a choice, and it is written down

`BlendCalibration.region` selects where each projector's blend region sits.
`'limb'` — the default and everything `bench-results.json` was produced under —
ramps inward from each projector's own footprint edge. `'sector'` gives each
projector a longitude wedge of `360/count` and crossfades at the boundary with
its neighbour.

They are different models of what an SOS compositor does, not two spellings of
one. Under `'limb'` two projectors overlap across 71 degrees of longitude, and the
50/50 plateau in the middle of that is about 31 degrees wide — the rest of the
overlap is unequal, which is the whole of A-37's argument: 20 degrees into P1's
own territory the projector next door is still carrying more than a third of the
signal (`test/blend-region.test.ts` measures it). Under `'sector'` the overlap is
the blend band and nothing else.
docs/AMENDMENTS.md **A-37** has the evidence, the measurements, and the four
things that have to happen before the default can move. `test/blend-region.test.ts`
pins that opting out changes nothing — including that a rig which never mentions
the field serializes exactly as it did before the field existed.

## Everything on the sphere is read through one function

`contentAt` is the image plus the analytic graticule, and it is the ONLY place
in this package that samples `Scene.image`. `test/content.test.ts` asserts that
by reading the source, because the alternative was found the hard way.

The graticule used to be rasterised into the image. When it became analytic —
so the line the §7 gate measures would stop being displayed at the resolution of
whatever texture it had been baked into — `traceTwoRig` and the browser's shader
were moved onto `contentAt` and `sampleSurface` was not. `sampleSurface` is what
`renderProjectorView` and `renderRoomView` read, so the room view drew a grid on
the ball and the picture captioned *the image this projector is sending down the
cable* drew none. A sphere lit by four projectors sending no grid, with a grid on
it.

No metric was ever wrong: `metrics/grid.ts` evaluates the graticule analytically
and reads no rendered image. That is exactly why nothing failed — the whole
bench was green, and the disagreement existed only in pictures, which is the one
place this repository had no assertion. It has four now, and they are about the
class rather than the instance: the source-level rule above, that `sampleSurface`
returns what `contentAt` returns, that a graticule scene renders a graticule in
every one of the three renderers, and that a scene without one renders nothing
bright in any of them.
