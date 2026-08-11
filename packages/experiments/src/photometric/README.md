# `photometric/` — Experiments 2 and 3

**Input:** nothing. Both experiments are deterministic functions of PARAMETERS.md's
own nominals and ranges, read from `packages/calibration/src/parameters.ts`.
**Output:** `experiments/experiment-2.{json,svg}`, `experiments/experiment-3.{json,svg}`,
and the two findings in `docs/EXPERIMENT-2.md` and `docs/EXPERIMENT-3.md`.

```
node packages/experiments/src/cli.ts 2            # Experiment 2, ~40 s
node packages/experiments/src/cli.ts 3            # Experiment 3, ~75 s
node packages/experiments/src/cli.ts photometry   # both
```

Experiment 1 lives next door in `../experiment1/` and is a different shape of thing —
a two-hour solver sweep with resume. These two are minute-scale sweeps over the
forward model only; no solver runs.

## Everything here is PROVISIONAL

docs/ARCHITECTURE.md's phase gate: Phase 2 is BUILD BUT DO NOT OPTIMIZE, because every
constant these experiments consume is class `ASSUME` and **nobody has measured any of
them**. So:

- every results file carries `provisional: true` and a `provisionalNote`;
- both figures carry the word PROVISIONAL on their face, and `test/plot.test.ts`
  asserts it — a figure travels further than the document it came from;
- nothing here is tuned, and each sweep runs **once**. There is no `--tune`, no
  best-of-N, and nothing that reads a previous run.

## The modules

| Module | Responsibility |
| --- | --- |
| `model.ts` | The one place a PARAMETERS.md parameter id becomes a number the model uses. An unknown id throws rather than being ignored — a constant that never reaches the model reports zero sensitivity, which is indistinguishable in the output from one that does not matter |
| `misregistration.ts` | Experiment 2's registration knob: a rigid rotation of each projector about the polar axis, alternating in sign, giving every adjacent pair exactly `R·ε·cos(lat)` of across-seam displacement |
| `artifact.ts` | How a seam artifact is measured — and the **two estimators that were rejected**, with the measurements that disqualified them |
| `experiment2.ts` | The sweep, the contour, the realistic cross-check, and the falsification criteria written down before the numbers |
| `experiment3.ts` | The sensitivity sweep, the stated/inferred split, the pairwise interactions, and the mechanical §10 comparison |
| `plot.ts` | Two figures as self-contained SVG. No dependencies, no JavaScript in the output |
| `cli.ts` | Run once, write the results file and the figure |

## The one thing worth reading before changing anything

`artifact.ts`'s module note. Experiment 2 measures a seam artifact by rendering **one
physical rig twice** — once with the content calibration it has, once with the
compositor holding the truth — and differencing point for point. That is not the
obvious choice and the two obvious choices are both wrong:

- **Sliding §7's estimator along the overlap** gives a lovely-looking answer that moves
  by a factor of eighteen when the window changes, because at the ramp band there is no
  step to measure, only curvature. It is kept in the file as `estimatorScan`, measured
  at three window sizes in every baseline of the results file, and asserted still
  scale-dependent by `test/artifact.test.ts`, so the rejection stays reproducible.
- **Differencing against the nominal rig** compares two different *physical* rigs, so it
  reports the change in incidence and distance from moving the lenses — about 1.4% at
  the ramp band — as if it were a blend error.

## What the tests pin

- `misregistration.test.ts` — the knob is calibrated: `packages/sim`'s own geodesic
  measurement of where two projectors land the same texel agrees with the closed form
  to 1%, through the frustum, the distortion model and a ray-sphere intersection.
- `artifact.test.ts` — a registered rig reports **exactly zero** artifact at every ramp
  shape and width; the blend residual is linear in the displacement and inverse in the
  width; a wider ramp hands *less* light to a grazing projector; and the rejected
  estimator is still scale-dependent.
- `model.test.ts` — every constant Experiment 3 sweeps is one `buildModel` can apply, an
  unknown id throws, and sweeping a projector's gamma moves the display without moving
  the compositor's assumed gamma (which is what makes §3.2's artifact possible at all).
- `plot.test.ts` — both figures are well-formed XML, self-contained, inside their own
  frame, free of `NaN`/`Infinity` coordinates, and say PROVISIONAL.
