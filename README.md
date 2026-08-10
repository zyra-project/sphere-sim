# sphere-sim

A physically-based simulator of a projected spherical display, and an alignment
solver that calibrates one from camera images.

The two are **deliberately independent**. They share no geometry code, no
projection math, and no distortion model — only a JSON document and the prose
describing what its numbers mean. If they shared implementation, the solver
would be inverting the simulator's own arithmetic, every recovery score would be
circular, and the project would be worthless. `tools/boundary-lint.ts` fails the
build on any import across that line.

## Start here

| Document | What it is |
| --- | --- |
| [`docs/PARAMETERS.md`](docs/PARAMETERS.md) | **The spec.** Authoritative for every physical constant, its provenance class, and its uncertainty |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Package layout, the phase gate, the Phase 1 loop decomposition |
| [`docs/AMENDMENTS.md`](docs/AMENDMENTS.md) | Ambiguities found while implementing the spec. Proposed, never silently applied |
| [`packages/calibration/README.md`](packages/calibration/README.md) | The boundary object, and why it contains no code |
| [`packages/bench/README.md`](packages/bench/README.md) | The scorer: how a solve is graded, how the gauge is removed, and how to read `bench-results.json` |

## The honesty structure

PARAMETERS.md classifies every constant by where it came from. That
classification drives how the work is sequenced:

- Every **geometric** parameter is `DOC`, `CFG`, or `SOLVE`. Ground truth is
  free — the simulator knows the true poses — so geometry gets optimized in a
  loop against injected misalignment with fresh seeds every round.
- Every **photometric** parameter is `ASSUME` or `MEAS`. Nobody has measured
  them. So photometry gets **built and tested but not optimized**, and every
  photometric metric is marked **PROVISIONAL** in the report. Optimizing against
  unmeasured constants produces confident nonsense.

## Commands

```bash
npm install                # one dev dependency: typescript. zero runtime deps
npm run ci                 # boundary lint, typecheck, tests
npm run bench              # headless deterministic bench -> bench-results.json + PNGs
npm run experiments        # the three experiments, each run once
npm run harness            # interactive WebGL harness
```

Node 22.18+ runs the TypeScript directly; there is no build step for anything
but the browser bundle.

## Three geometry facts this implementation must reproduce

From PARAMETERS.md §4.2 and §4.3. They are counterintuitive, so they are
asserted in tests and rendered as a static reference on the progress page:

1. **Overlap multiplicity never exceeds 2.** Not 3, not 4, anywhere on the
   sphere. Three-way overlap would need a point within 80.4° of three equatorial
   directions spaced 90° apart; the only candidate region is polar, and the poles
   sit exactly 90° from every projector.
2. **The unlit polar region is four-lobed and scalloped, not a circular cap.**
   Coverage reaches 80.4° latitude along a projector's meridian but only 76.3°
   in the seam directions.
3. **The deployment target is one framebuffer split into four quadrant
   viewports**, not four independent outputs.

If the code contradicts any of these, the code has a bug.

## Status

Phase 1 (geometry) is the active loop. Phase 2 (photometry) is build-only by
design. See the progress page for live metrics against gates, solver residual
scatter, and the three experiment results.

---

*Science On a Sphere® is a registered trademark of NOAA. This is an independent
simulator and is not a NOAA product.*
