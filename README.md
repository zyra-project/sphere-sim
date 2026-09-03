# sphere-sim

[![DOI](https://zenodo.org/badge/1329975775.svg)](https://doi.org/10.5281/zenodo.22101428)

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
| [`packages/experiments/README.md`](packages/experiments/README.md) | The measurements. Each runs once and is not iterated |
| [`packages/meshio/README.md`](packages/meshio/README.md) | The model-file reader, and why a loader cannot live where either model can reach it |
| [`packages/web/README.md`](packages/web/README.md) | **The interactive simulator.** Walk around a projected sphere; press one button to run a real calibration in the browser |
| [`packages/harness/README.md`](packages/harness/README.md) | The developer harness, and exactly which links of the GPU↔CPU parity chain are verified by execution |
| [`validation/README.md`](validation/README.md) | Photographs of real installations beside our render. Plausibility only — no metric, no gate, no score |
| [`docs/EXPERIMENT-1.md`](docs/EXPERIMENT-1.md) | **How many photographs a calibration needs, and whether a phone suffices.** Measured |
| [`docs/VISIT.md`](docs/VISIT.md) | **The ground-truth visit field card.** What to measure, in cut order, with framing diagrams |
| [`docs/ARBITRARY-SHAPES.md`](docs/ARBITRARY-SHAPES.md) | **Feasibility study, and the running record of building it.** What it takes to render an uploaded GLB with projectors anywhere, and where the sphere is load-bearing. Phases 0-4 are implemented: a `.glb` dropped on the page is traced, lit, blended, and lit by any number of projectors placed anywhere — and Phase 2 put the mesh on the GPU, so the live view traces the dropped model rather than a sphere. A Bourke warp-and-blend file is written by `packages/sim/src/warp.ts` — from the library, not yet from a button. Phase 5's calibrated solve has landed and the page runs it: drop a `.glb`, press Solve, and the capture photographs the model while the bundle fits it — four tri-axial bodies at the rig's radius recover to 8-14 mm across three noise seeds on the page's own configuration, where the analytic sphere gets 8-17 — with the sphere path byte-identical across the twelve-scenario baseline. Still open, and measured there: a NEARLY spherical mesh is less accurate than the sphere it approximates, which the flat-facet Jacobian explains and a smooth-normal Jacobian is the next experiment for |
| [`docs/USAGE-ACCOUNTING.md`](docs/USAGE-ACCOUNTING.md) | What building this cost, in dollars and in kilowatt-hours. The bill is measured; the environmental figure is **PROVISIONAL** |
| [`skills/usage-report/SKILL.md`](skills/usage-report/SKILL.md) | The same accounting as an installable, project-agnostic Claude Code skill |

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

The same rule is applied to the project's own resource accounting, which is why
`npm run usage` reports two halves with different standing rather than one
number: the **cost** is measured token counts at published rates, the
**environmental impact** is those counts through a chain of non-public constants,
and only the first can be quoted. See
[`docs/USAGE-ACCOUNTING.md`](docs/USAGE-ACCOUNTING.md).

## Commands

```bash
npm install                # one dev dependency: typescript. zero runtime deps
npm run ci                 # boundary lint, typecheck, tests
npm run bench              # headless deterministic bench -> bench-results.json + PNGs
npm run gate               # judge bench-results.json against §7; exits non-zero on an
                           # unwaived gate failure. See gate-waivers.json.
npm run experiments        # experiments 2 and 3, each run once
npm run experiment1        # experiment 1: camera count, resolution, floor reference,
                           # and each degradation on its own. ~2 h; --list prints the budget
npm run experiment4        # experiment 4: what the room behind the sphere costs the
                           # solve, and whether a decoder threshold can reject it. ~9 min
npm run build:web          # compile sim + calibration + harness to browser ESM
npm run harness            # developer harness on http://localhost:8173/
npm run build:app          # compile sim + solver + bench + the app to browser ESM
npm run app                # interactive simulator on http://localhost:8174/
npm run smoke:app          # load the app in a real browser: does the shader compile?
npm run build:site         # assemble site/ — the app, the harness and the progress page
npm run usage              # what this project cost, in dollars and (PROVISIONALLY) in kWh,
                           # litres and kgCO2e. --html <path> writes the shareable page
npm run pack:skill         # build dist/usage-report.skill — the portable form of the
                           # above, installable in any Claude Code project
npm run check:citation     # CITATION.cff and package.json must name the same version;
                           # the release workflow tags whatever package.json says
npm run check:license      # every source file carries an SPDX header
node tools/license-header.ts --fix   # add the header to files that lack one
node packages/bench/src/validation.ts   # regenerate validation/index.html (reads local files only;
                           # images are never fetched — the owner supplies them)
```

Node 22.18+ runs the TypeScript directly; there is no build step for anything
but the browser bundle.

Both servers bind loopback only. They read repository files under `/repo/`, so
the default is deliberate; `HOST=0.0.0.0 npm run app` opens them to the network
when that is what you want — a tablet beside the sphere, say — and the terminal
then prints the address it actually bound rather than `localhost`.

## Releases and citation

A release is cut from `main` whenever `package.json` names a version that has no
tag yet, so cutting one is a deliberate one-line commit rather than a side effect
of merging. `CITATION.cff` has to move in the same commit — `check:citation`
fails CI otherwise, which catches a mismatched release before a DOI is minted
rather than after.

Archived on Zenodo. Cite the **concept DOI** — [`10.5281/zenodo.22101428`](https://doi.org/10.5281/zenodo.22101428)
— which always resolves to the newest version; a version DOI pins a reader to
whatever release was current when they wrote.

Licensed under **Apache 2.0** — see [`LICENSE`](LICENSE), with the copyright
holder and the NOAA trademark disclaimer in [`NOTICE`](NOTICE). Every source file
carries a two-line SPDX header, enforced by `check:license`; the short form
rather than the full sixteen-line boilerplate, because 186 of 191 files open with
a doc comment explaining what they are for and burying those was the wrong trade. `check:citation`
keeps the licence named consistently in `package.json` and `CITATION.cff`, so a
release cannot be cut claiming terms the repository does not carry.

v0.1.0 was tagged before the licence landed, so it is archived under GitHub's
default of all-rights-reserved. v0.1.1 is the first release anyone can actually
use — cite that one.

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
