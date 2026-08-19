# sphere-sim architecture

## The shape of the thing

```
                    packages/calibration
                  (types, constants, prose)
                     NO EXECUTABLE MATH
                       ▲            ▲
                       │            │
        ┌──────────────┘            └──────────────┐
        │                                          │
   packages/sim                              packages/solver
   FORWARD MODEL (A)                         INVERSE MODEL (B)
   equirect image + calibration              camera images
        → room view + metrics                     → calibration
   own geometry, own optics,                 own projection, own
   own distortion inversion                  distortion, own bundle adj.
        │                                          │
        └──────────────┐            ┌──────────────┘
                       ▼            ▼
                    packages/bench
              the scorer — where the two
                  models are compared
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
  bench-results   progress page   experiments   packages/web
     .json        (live, updated)  (run once)   the browser app
```

`packages/bench` and `packages/web` both import both sides, and that is the only
arrangement in which a solve can be scored at all. The rule the lint cannot
check applies to each of them: **neither may become a PATH between `sim` and
`solver`.** No helper is shared by both sides; each call hands one model's output
to the other as data, through the boundary types.

`packages/sim` and `packages/solver` may import `packages/calibration` and
nothing else across package lines. `tools/boundary-lint.ts` enforces this as an
allowlist, not a denylist, so a shared "utils" package is caught as the same
violation with an extra hop. Thirteen tests exercise the rule itself, including
the dynamic-import, re-export, and `import type` loopholes.

### Why the scorer is a separate package

`bench` imports both sides. That is fine and necessary — something has to hold
the ground truth in one hand and the recovered calibration in the other. What
matters is that neither model can reach the other *through* it: `sim` never
imports `bench`, and `solver` never imports `bench`, so there is no path.

## Phase gate

The project owner set this and it is the part most likely to go wrong, so it is
written down here as well as in the prompt.

| | Phase 1 — geometry | Phase 2 — photometry |
| --- | --- | --- |
| **Instruction** | OPTIMIZE IN A LOOP | BUILD BUT DO NOT OPTIMIZE |
| **Ground truth** | Free — the simulator knows the true poses | None. Nobody has measured these constants |
| **Provenance** | `DOC`, `CFG`, `SOLVE` | `ASSUME` and `MEAS`, every one |
| **Output marking** | Normal | **PROVISIONAL** on every metric |
| **Loop** | Builder + fresh-context critic, fresh seeds each round | No loop. Implement, test, stop |

The reason for the asymmetry, from PARAMETERS.md §10: optimising against
unmeasured constants produces confident nonsense. A photometric metric that
passes its gate today is a statement about `γ_B = 2.2`, which nobody has
measured, and which PARAMETERS.md ranks as the single highest photometric risk.
Tuning the blend model until that metric goes green would encode the guess into
the product and then present it as a result.

Mechanically enforced where possible: every metric carries a `provisional` flag,
the report renders provisional metrics in a visually distinct block, and the
loop runner refuses to score a round on a provisional metric.

That last clause was aspirational until `loop.ts:assertScorable` implemented it.
It now throws — naming the metric and this paragraph — rather than letting a
number that rests on an unmeasured constant decide whether a round improved. The
flag is carried on the gate as well as on the metric, so the CI gate step
(`packages/bench/src/gate.ts`) can apply the same rule to a build: a provisional
gate is reported and never judged, because failing a build on one would encode a
guess as a requirement.

## Phase 1 loop decomposition

The owner left the decomposition to me. The unit is *the smallest thing that can
be improved and judged separately*, which in practice means: a piece whose
failure shows up in a distinguishable signature in `bench-results.json`.

| # | Piece | Owns | Primary signal it moves | Distinguishing signature when it is the problem |
| --- | --- | --- | --- | --- |
| G1 | **Decode** | Gray-code + phase-shift decode, validity masking, per-correspondence uncertainty | correspondence count, decode error vs truth | Residuals large and *random*; error concentrated at grazing incidence and seam edges |
| G2 | **Bootstrap** | Initialization from nominals to a convergent basin | convergence rate, iterations | Bimodal outcomes: most scenarios excellent, a few catastrophic. A mean hides this; dispersion does not |
| G3 | **Bundle core** | Parameterization, damping, scaling, gauge, convergence | pose recovery error, residual RMS | Residuals *structured* — radial or quadrant patterns in the scatter |
| G4 | **Distortion** | `k1`, `k2` recovery; `p1`, `p2` held at zero per §3.1 | intrinsics recovery error | Residuals radially structured, growing with image radius |
| G5 | **`h_center`** | Free-parameter recovery from a floor reference | `h_center` error in mm | Vertical grid lines diverging near the poles — the exact symptom §1's note describes |
| G6 | **Robustness** | Outlier rejection, loss function, weighting | p95 and max error vs RMS | RMS fine, tail terrible |
| G7 | **Sampling** | Which surface points become correspondences, coverage weighting | error distribution over lat/lon | Equirectangular error map shows error concentrated where samples are sparse |

Each piece gets a **builder** and a **separate critic with fresh context**.
Critics read `bench-results.json` and the rendered views. They never read the
builder's reasoning, its commit message, or its explanation — only its output.
When a metric fails its gate, the critic names **the single largest
contributor** and that piece goes back.

Scenarios regenerate with fresh seeds every round. A piece that improves on
round *n*'s seeds and regresses on round *n+1*'s did not improve; it overfit.

### Stopping condition

The loop runs until the numbers stop moving or the owner stops it. "Stop moving"
is defined rather than eyeballed: a round is *non-improving* when no gate-facing
metric's round-over-round change exceeds its own run-to-run dispersion across
seeds. Three consecutive non-improving rounds ends Phase 1.

### How a round is ranked, and the one rule that matters

A round is ranked on a **vector** — one component per scored geometric gate,
each divided by its own limit so millimetres, degrees and a bare fraction share
a unit without anybody choosing a weight. `packages/bench/src/loop.ts`'s
`TRACKED` is the list; **pose recovery is in it**.

That is not a detail. The loop ranked on median grid displacement alone until
the bench's own counterfactual attribution showed the metric is blind to pose:
substituting the *true* projector positions into a recovered calibration makes
grid displacement **worse** (61.18 mm against 1.058 mm as recovered), because
the recovered rig is internally self-consistent — every projector is wrong in a
way that agrees with every other projector, so their copies of a grid line still
land on top of each other. A 59 mm pose error cost that ranking nothing.

The comparison rule, stated once and implemented in `betterThan`:

> Round A is better than round B when **no** tracked metric is worse by more
> than the scatter of the two rounds, **and at least one** is better by more
> than that scatter. Anything else is `mixed`, `worse` or `flat`, and only
> `better` displaces the incumbent best.

There is deliberately no trade-off arithmetic. A weight is an editorial
judgement about which failure matters and the loop is not entitled to make it —
§7 sets five limits and does not rank them. **A round that regresses pose
recovery is never recorded as an improvement**, whatever else it moved.

## The three experiments are not the loop

They are measurements. Each runs **once**, produces a plot and a written finding,
and is not iterated to improve its result. Iterating an experiment until it says
something better is how a measurement becomes an advertisement.

| # | Experiment | Question it answers |
| --- | --- | --- |
| 1 | Camera positions, 1→8, with noise / ambient / rolling shutter as separate conditions | How many photos does a real calibration need, and does a phone suffice? |
| 2 | Blend softness vs geometric tolerance | Does soft blending buy geometric tolerance? If yes, the value proposition inverts |
| 3 | Photometric sensitivity across every ASSUME constant's plausible range | Which unmeasured constants actually matter — i.e. what gets measured on the real-sphere visit |
| 4 | The room the light that misses the sphere lands on, against the decoder's own rejection floor | What does the wall behind the ball cost a calibration, and can a threshold reject it? |

Experiment 2's hypothesis is the commercially interesting one, and it is
testable entirely in simulation. Experiment 3's output is a work order for the
ground-truth visit in PARAMETERS.md §8.

Experiments 2 and 3 depend on Phase 2 photometry, so their outputs inherit the
PROVISIONAL marking. Experiments 1 and 4 are purely geometric and do not.

Experiment 4 came from a reader looking at a capture preview and saying the
background would never be that black. It would not; and the reason the bench's
was is that an off-sphere pixel had no geometry behind it at all. The condition
it added is off by default, so no published number moved, and what it measures is
the one thing the bench had never been asked: what happens when the pixels that
are not the sphere stop being a constant.

## Three interfaces, same core

- **Developer harness** (`packages/harness`) — one window, one WebGL2 context,
  five viewports (room view, four projector views) plus a live metrics panel,
  sliders for every parameter in PARAMETERS.md. Everything stays on the GPU. For
  a human building intuition, and for checking that the metrics track what the
  eye sees.
- **Headless bench** (`packages/bench`) — renders N seeded scenarios, writes
  `bench-results.json` and PNGs. Deterministic. **This is what critics read.** A
  live window is never screenshotted for scoring.
- **Browser app** (`packages/web`) — the same models, for somebody who has never
  read PARAMETERS.md. It is the only interface that holds TWO calibrations at
  once — what the lenses do and what the software believes — which is the only
  way misregistration can be shown at all, and the only one that can run a live
  solve.

### The parity risk, and where each interface answers it

The harness and the app render with GLSL; the bench renders on the CPU. Those
are two implementations of the simulator's *own* model, which is a different
thing from the A/B duplication and carries a different risk: they can drift
apart silently, and a human then builds intuition from a renderer nothing scores.

The harness pins its shader with a headless chain — a line-for-line TypeScript
transliteration, a structural test, a CPU comparison in CI — and displays the
runtime GPU delta. The app cannot reuse that shader, because a single-calibration
renderer cannot show misregistration, so it has its own and measures the delta
against `packages/sim`'s two-rig renderer at runtime, on screen.

Neither can prove the shader compiles, which no headless test can.
`tools/smoke-app.ts` does, by driving Chromium over the DevTools protocol with
nothing but Node's built-in `WebSocket`; it runs in the Pages workflow before a
deploy.

## Determinism

Every render is a pure function of `(calibration, scene, seed)`. No wall-clock,
no unseeded randomness, no order-dependent floating-point reduction. CI runs the
bench twice with the same seed and diffs the output.
