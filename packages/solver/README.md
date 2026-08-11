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
- **A prior on the field of view does not close that valley, and the reason is
  measurable.** Swept at one-sigma widths of 0.5, 1, 2, 3 and 4 degrees over the
  bench's twelve-scenario corpus, the worst-case pose position error moved from
  639.6 mm to 622.1 mm — under 3%. The formal one-sigma on `fovHDeg` from the
  normal equations, with the residual scale taken from the fit itself, is about
  0.15 degrees, while the recovered field lands 2.5 to 4.9 degrees from truth on
  the scenarios carrying a decode bias. That is a twenty-sigma error: the failure
  along the valley is BIAS, and any prior a spec sheet could justify is two
  orders of magnitude weaker than the wrong data it has to argue with. HOLDING
  the field does help — by a factor of three to eight on those scenarios —
  because it is an infinitely tight prior at a value nearer the truth than the
  fit; it also costs the `long-throw` case a factor of 1.6, because that site
  really is at the far end of PARAMETERS.md §2's unresolved `d_proj` conflict and
  the nominal field derived from the near end is 4.85 degrees wrong. See
  docs/AMENDMENTS.md A-13. `SolvePriorOptions.fovHDegSigma` exists for a site
  that has read its own spec sheet; it is 0 by default.
- **Lens shift is nearly degenerate with pointing, and it is what decides the
  rotation gate.** The smallest eigendirections of the normal equations at the
  solution are 53-64% pitch, 41% yaw and 15% `shiftV`, at a condition number of
  3e7 to 1e8 in the diagonally-scaled metric. The arithmetic is elementary: at a
  33-degree field on a 1920-wide raster the focal length is 3195 px/rad, so a
  `shiftH` of 0.01 — ten pixels of principal point — is worth 0.172 degrees of
  yaw, and the only thing separating them is the second-order difference between
  translating a principal point and rotating a lens. Pinning `shiftH`/`shiftV` at
  PARAMETERS.md §3.1's nominal of zero drops the worst pose-rotation error on the
  corpus from 6.29 degrees to 0.30. It is NOT pinned by default, because §3.1
  gives lens shift a nominal and a class but no uncertainty, and whichever sigma
  gets chosen is then the number that decides whether §7's 0.05-degree gate is
  reachable. Filed as docs/AMENDMENTS.md A-12; the mechanism is
  `SolvePriorOptions.shiftSigma`, default 0.
- **The per-correspondence sigma used to be a one-degree-of-freedom draw.** With
  the recommended four phase steps, fitting `A + B*cos(phi - 2*pi*n/N)` leaves
  `N - 3 = 1` residual degree of freedom, so the old per-pixel noise estimate was
  `sigma * |z|` for a standard normal `z`. Measured against ground truth on the
  bench corpus, the reported sigma spread a factor of thirty across its own
  deciles while the actual decode error spread a factor of two, and the rank
  correlation between the two was 0.05-0.20. Since the bundle weights by
  `1/sigma^2` and the outlier pass thresholds on `|r|/sigma`, that meant lucky
  pixels were given a thousand times their share of the normal equations and
  seventeen to twenty-one per cent of perfectly good correspondences were thrown
  away at random. `decode.ts` now pools the noise estimate over the whole frame,
  binned by each pixel's own DC level so the shot-noise dependence survives. On
  the scenarios whose errors are noise-limited rather than bias-limited the pose
  position error fell by a factor of 2.5 to 3.6 and the estimator became
  statistically consistent — the ratio of the observed residual variance to the
  variance the decode claims is now 1.02 on `nominal`, against 11 to 375 on the
  scenarios that carry an inter-frame motion bias. `DecodeOptions.noiseBins: 0`
  restores the old behaviour for comparison.
- **Residual coherence within a (camera, projector) pair is detectable, and
  inflating that pair's sigma does nothing about it.** `pairCoherence` bins a
  pair's residuals over the projector raster, standardises each axis by that
  pair's own robust scale, and compares each cell's mean against what independent
  noise allows. It separates the two regimes cleanly: on the bench corpus it
  fires on 0 to 1 of 12 pairs under a tripod (largest inflation 1.25x) and on 9
  of 12 under handheld motion (a typical pair inflated 5x to 8x, several at the
  8x cap). **It also fires on heavy tails with no structure present at all** —
  its scale estimator is `median(|r|)/0.6745`, a Gaussian relation, so i.i.d.
  Student-t(3) inflates 3 of 12 pairs and a 90/10 Gaussian mixture 7 of 12. So
  it discriminates kurtosis as readily as coherence, and an outlier-contaminated
  decode is heavy-tailed. It is blind by
  construction to both apparatus signatures the progress page subtracts — the
  1920/1080 raster-aspect anisotropy of the decode, which per-axis
  standardisation removes, and the axis-aligned quantisation cross, which is
  zero-mean inside any cell. Measured PAIRED on five fresh seeds and seven
  archetypes, 35 cells: **grid displacement 1.00x median, pose position 1.00x
  median.** Inert. It is off by default and kept because it is the apparatus for
  the next attempt, not because it earns its place today. See docs/PHASE-1.md for
  why a per-pair weighting cannot work here and what shape the fix has to be.
- **`tieProjectorFov` solves one field of view for the whole rig.** PARAMETERS.md
  §3.1 derives `fov_h` from the throw ratio `T` and classes `T` as CFG, one spec
  sheet per install — so a site running four of one model has one field of view,
  not four. Paired on the same 35 cells it is worth **1.51x median on pose
  position (28 helped, 4 hurt)** and **0.99x on grid displacement (15 / 16)**. It
  is off by default because §3.1 does not say whether an install's projectors
  share `T`; filed as docs/AMENDMENTS.md A-33 with the numbers.
- **`p1`, `p2` are off by default**, per PARAMETERS.md §3.1.
- **Sparse camera coverage is the fragile case.** Two cameras under heavy ambient
  and sensor noise is close to the edge of what the bootstrap handles; three is
  comfortable. Experiment 1 exists to measure exactly this.
- **A per-camera variance component is the part of that which the fit CAN
  measure.** The residuals see the motion even though the decoder cannot, so
  `runBundle` estimates, between passes, how many times worse each camera's
  standardised residuals actually are and rescales that camera's weights —
  floored at 1, because unmodelled error can only add variance and a camera is
  never allowed to claim it beat its own decode. It is reported as
  `cameraResidualScale`, which is the diagnostic worth reading first on a bad
  scenario: 1.0 means the decode's uncertainty model was right for that camera,
  and 3 means two thirds of its error is something no per-pixel formula could
  have seen. On the bench corpus it moves the MEDIAN pose position error (270 ->
  236 mm at seed 1234, 232 -> 153 mm at seed 428948602) and leaves the worst case
  alone, which is what a reweighting can be expected to do: it helps when cameras
  differ from each other and does nothing when they all moved about the same.
- **A correspondence is not one observation, and modelling it as one is a
  measurable error.** Its `u` is read from one block of frames and its `v` from
  a later block — with the recommended plan, the phase-`u` frames are 26-29 of
  34 and the phase-`v` frames 30-33, so the two coordinates are photographed
  four frame intervals apart. `decode.ts` now reports both epochs on the
  correspondence (`timeU`, `timeV`, in pattern frames, read off the capture's
  own structure), and `BundleFreeFlags.cameraVelocity` lets the bundle solve a
  rate of change of each camera's pose so that the `u` residual is evaluated at
  the camera pose of the `u` epoch and the `v` residual at the pose of the `v`
  epoch. Two epochs per pair is all the data has, so an offset and a rate is the
  whole of what is identifiable — a richer trajectory would be damping, not
  modelling. `rotation` frees three parameters per camera and `full` six; the
  epochs are inert with the rate held, which `test/time-aware.test.ts` asserts
  bit-for-bit.

  Measured PAIRED on five fresh seeds and ten archetypes, 50 cells: **grid
  displacement 1.63x median (36 helped, 9 hurt)**, every motion archetype
  improving (2.0x to 6.0x) and the four tripod archetypes a wash at 1.00x and
  still inside the 1.0 mm gate. Pose position 1.21x, pose rotation 1.66x. The
  six-DOF variant is larger (2.22x) and takes `s02-sensor-noise` out of the
  gate, which is why `rotation` is the default and `full` is not: at 2.6 m a
  hundredth of a degree of pointing moves the observed point 0.45 mm and a
  hundredth of a millimetre of translation moves it a hundredth of a
  millimetre, so the angular rates carry the signal and the translational ones
  mostly carry variance.

  It also does NOT absorb an injected projector pose error — it recovers one
  better. Injecting 1.0 deg of yaw and 20 mm of position truth-side and solving
  both captures, the baseline returns the position at 0.29x and 1.64x on the two
  handheld seeds while the rate-free solve returns 0.76-0.92x, and the injected
  POINTING (yaw plus the yaw that lens shift is worth, since A-12 makes those
  nearly one parameter) goes from 0.82-1.14x to 0.99-1.01x.

  **The clock is an assumption and it is decisive.** `frameEpochs: 'perCapture'`
  assumes every projector's sequence starts from the same point of the
  operator's motion, which is what `packages/bench` simulates and NOT what a
  real back-to-back capture does. Re-attributing the same captures to a
  `sequential` clock turns the 1.63x into **0.30x, 1 cell helped and 44 hurt** —
  getting the clock wrong is three times worse than not modelling time at all.
  Filed as docs/AMENDMENTS.md A-34, which asks §8 to record frame timestamps.
  See docs/PHASE-1.md for all of it, including why the model that would transfer
  to a real capture is a rate per (camera, projector) PAIR rather than per
  camera.
- **Handheld motion is a decode BIAS, and no weighting removes it.** A 34-frame
  sequence at 20 fps takes 1.7 s, over which the modelled handheld drift moves
  the lens about 3.4 mm and turns it about 0.085 degrees. Measured against the
  simulator's own forward projection, the median decode error on the `six-cameras`
  capture is 4.50 projector pixels with the motion on and 0.23 with it off — a
  twentyfold difference, and the largest single term in the whole corpus. It is
  not noise: it is coherent within a (camera, projector) pair and it differs
  between the u and v sequences because they are photographed at different points
  in the sequence. Re-weighting cannot help, and the measurements say so: an
  ORACLE weighting, with every correspondence's sigma set to its true error,
  makes the affected scenarios worse rather than better, while an oracle
  REJECTION that keeps only the correspondences whose true error is under a pixel
  improves them by 20-40%. What the solver would need is a time-aware decode that
  models the camera pose per frame; nothing available to the current decoder
  senses the bias from inside one frame set. **Round 3 built that** — see the
  bullet above — and the oracle's verdict survives it: modelling WHEN each
  coordinate was measured is not a weighting, which is why it works where three
  rounds of weighting did not.
