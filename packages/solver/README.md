# packages/solver — the inverse model (B)

**Input:** camera images of structured-light patterns.
**Output:** a `RigCalibration`.

Has **its own** projection math, its own distortion model, its own bundle
adjustment. Shares nothing with `packages/sim`.

## The duplication in here is deliberate. Do not refactor it away.

Read `packages/sim/README.md` for the full argument. The short version: this
package must be able to be *wrong independently*. If the solver imported the
simulator's projection code, then scoring the solver against the simulator's
ground truth would be measuring whether a function can invert itself — which it
always can, to machine precision, no matter how badly either models a real
projector aimed at a real sphere.

The two sides agree only on `packages/calibration`: a JSON document and the
prose in `conventions.ts` describing what its numbers mean. Each side implements
that prose from scratch.

**The disagreements are the product.** When this package's independent reading
of §D (distortion is defined ideal → distorted) differs from the simulator's,
pose recovery error blows up and the bench reports it. That is the alarm working.
Resist the urge to silence it by sharing code; fix whichever side misread the
convention.

CI enforces this: `npm run lint:boundary` fails on any import across the
boundary, in either direction, static or dynamic.

## What lives here

| Module | Responsibility |
| --- | --- |
| `project.ts` | World → projector pixel, forward distortion. Independent derivation. |
| `sphere.ts` | Camera ray → sphere surface point. Independent derivation. |
| `decode.ts` | Gray-code + phase-shift decode, camera pixel → projector pixel |
| `initialize.ts` | Bootstrap from nominals to a basin the optimiser can finish |
| `bundle.ts` | Levenberg–Marquardt over poses, intrinsics, distortion, `h_center` |
| `robust.ts` | Outlier rejection, Huber loss, residual reporting |

## What the solver is allowed to know

- The nominal values in `PARAMETERS.md`, as **initialization only** (§2: "All
  six pose DOF are `SOLVE`. Nominals exist to initialize the solver").
- The sphere radius, class `DOC`.
- Camera intrinsics, if the operator calibrated their camera.

## What the solver is NOT allowed to know

- The ground-truth calibration used to generate its input images. The bench
  passes images and nothing else; ground truth is held by the scorer.
- Anything at all from `packages/sim`.

`h_center` is recovered as a free parameter rather than trusted from a tape
measure — PARAMETERS.md §1 explains why this is a concrete improvement over the
documented add-or-subtract-an-inch procedure, and the bench scores it separately.

---

## How the pipeline fits together

```
camera images  ──decode.ts──▶  correspondences (+ per-point sigma)
                                      │
   camera intrinsics + nominals ──initialize.ts──▶  a state in the right basin
                                      │
                               bundle.ts (LM)  ──▶  RigCalibration + diagnostics
                                      ▲
                     project.ts (world → projector pixel, §R/§I/§D)
                     sphere.ts  (camera pixel → ray → surface)
                     robust.ts  (Huber loss, rejection pass)
                     linalg.ts  (Cholesky/LDL^T, Jacobi, Kabsch, PRNG)
```

`solve(input)` in `index.ts` is the entry point. Give it either raw
`captures` or pre-decoded `correspondences`, the operator's camera intrinsics and
rough tripod poses, the PARAMETERS.md nominals as a `RigCalibration`, and — if
`h_center` is wanted — one or more floor heights.

## Structured light: what the patterns must look like

The normative pattern definition is at the top of `decode.ts`. Two points that
are easy to get wrong and expensive to debug:

- Patterns are specified in **linear radiance**, not encoded signal. A sinusoid
  emitted as signal arrives at the sphere distorted by the projector's per-channel
  gamma (conventions.ts §P, PARAMETERS.md §3.2, all class ASSUME), and its
  harmonics bias the phase estimate. Pushing the transfer compensation onto the
  pattern generator keeps an unmeasured photometric constant out of a geometric
  measurement.
- The phase period must be an **even multiple of the Gray stride**, two being the
  natural choice. Equal scales make the Gray-versus-phase cross-check
  structurally unable to fire, because every Gray misread then displaces the
  coarse estimate by a whole number of fringes and the unwrap silently agrees.

Use at least four phase steps: an N-step estimator rejects every harmonic except
those congruent to ±1 mod N, so N=4 rejects the second and third and N=3 rejects
neither.

## Gauge freedom — read this before scoring pose recovery

The sphere centre is the world origin and its radius is known, so translation and
scale are pinned. **Global rotation is not, and cannot be.** Rotate every
projector and every camera about the sphere centre by the same rotation and every
correspondence residual is unchanged. Three degrees of freedom, unobservable to
any solver — see `bundle.ts` and `docs/AMENDMENTS.md` A-09.

What this package does about it:

- During the solve, a **minimal-constraint (inner) gauge**: each LM step is
  penalised along the global-rotation null space, so the normal equations are
  non-singular without the penalty touching anything the data determines.
- How many of the three directions are actually free depends on the floor
  references, and the code **measures rather than assumes**. With none or one, all
  three: tilting the rig changes the measured height and `h_center` absorbs it
  exactly. With three or more non-collinear references, tilt becomes genuinely
  observable and the gauge leaves it alone. That is precisely why PARAMETERS.md
  §8 item 1 asks for "floor to each projector lens" rather than one height.
- After the solve, the answer is **re-expressed** in the frame PARAMETERS.md §2
  describes, along the free directions only. This changes no residual by a single
  ULP — it chooses which member of an equivalent family to report.
- `SolverExtraDiagnostics.gaugeFreeAxes` says which axes were fixed by convention
  rather than measured.

**A bench scoring against the §7 gate of 0.05° must align frames against its own
ground truth first.** The nominal-frame anchor is only as good as the nominal
layout, and a rig with ±3 cm of real position scatter pins the frame to about a
tenth of a degree.

## `h_center`

Nothing in a structured-light capture sees the floor, so `h_center` is observable
only through a measured height. Supply `floorReferences`; with none, it is held at
the documented 2.1844 m and reported unchanged rather than handed to the optimiser
as a free parameter it cannot determine.

The improvement over NOAA's add-or-subtract-an-inch loop is not that the tape
measure goes away. It is that this measurement is easy to take accurately (floor
to a lens you can touch) where theirs is not (floor to the centre of a suspended
sphere), and that the bundle propagates it through geometry pinned to
sub-millimetre. With four lens heights the synthetic tests recover `h_center` to
under a millimetre — forty times finer than the inch-sized step the documented
procedure works in.

## Known limits, measured

- **Field of view trades against radial distance.** A long-throw lens sees the
  sphere subtending about 19°, so there is very little depth baseline separating
  "further away" from "narrower field". With `fovHDeg` free, decode noise maps
  almost entirely into along-axis position error: roughly 7 mm per 0.05 px of
  per-correspondence decode noise in the three-camera synthetic scene. `fovHDeg`
  is class CFG in PARAMETERS.md §3.1 — derived from a throw ratio read off a spec
  sheet — so passing a good nominal and holding it is usually the right call, and
  the bootstrap holds it regardless.
- **`p1`, `p2` are off by default**, per PARAMETERS.md §3.1.
- **Sparse camera coverage is the fragile case.** Two cameras under heavy ambient
  and sensor noise is close to the edge of what the bootstrap handles; three is
  comfortable. Experiment 1 exists to measure exactly this.
