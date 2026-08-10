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
