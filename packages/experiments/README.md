# packages/experiments — the measurements

**Input:** one documented root seed.
**Output:** `progress/experiment-1.json` and four SVG figures beside it.

```
node packages/experiments/src/cli.ts --list        # the plan and the budget, runs nothing
node packages/experiments/src/cli.ts               # the published run, ~2 h
node packages/experiments/src/cli.ts --plots-only  # re-render the figures from the raw runs
```

docs/ARCHITECTURE.md draws this package downstream of `bench`, and the reason is
the whole design of it: an experiment measures the pipeline the scorer scores,
so it builds a `Scenario`, overrides the one axis under test, and hands it to
`packages/bench/src/run.ts:runScenario`. It does not assemble the forward model
and the solver itself. If it did, the first time the two disagreed nobody would
be able to say which was right, and every experiment number would need a second
provenance.

---

## These run once

> The three experiments are not the loop. They are measurements. Each runs
> **once**, produces a plot and a written finding, and is not iterated to improve
> its result. Iterating an experiment until it says something better is how a
> measurement becomes an advertisement.
> — docs/ARCHITECTURE.md

Mechanically, that means this package has no `--tune`, no best-of-N, no
convergence loop, and nothing that reads a previous run and changes the design.
`design.ts` states the whole design as data before anything runs, `--list` prints
it, and `CUTS` is part of the file rather than a note somebody may or may not
write afterwards.

The one thing that *does* read a previous run is `--plots-only`, which
re-renders the figures from `progress/experiment-1-runs.jsonl` without solving
anything. That is a renderer, not a re-measurement.

---

## Experiment 1 — the four axes

The brief named one axis: sweep 1 to 8 camera positions, plot solver recovery
error against count. docs/AMENDMENTS.md A-16 had already measured why that alone
answers the wrong question — at the corpus's operating point the error floor is
set by the floor-reference tape measure, not by the cameras — and A-18 then
corrected A-16 by showing the tape is the floor rather than the ceiling. Both
agree on the design consequence: **camera count is not the dominant axis**, so
measuring it alone would produce a flat line and an unearned conclusion.

| Axis | Levels | Held |
| --- | --- | --- |
| `camera-count` | 1..8 | 320x240 camera, sigma = 3 mm, four projectors |
| `resolution` | 320x240 .. 4032x3024 | 3 cameras, sigma = 3 mm |
| `floor-sigma` | 0.1 / 1 / 3 mm, plus no reference at all | 3 cameras, tripod |
| `degradation` | 8 conditions, each switched on alone | 3 cameras, 640x480 |

Two conditions carry the first two axes, and they differ in **exactly** the
camera motion and the shutter:

- `tripod` — static camera, global shutter, §5 nominal ambient, real sensor.
- `handheld` — the same with handheld motion and a rolling shutter.

That is not a stylistic choice. packages/bench/README.md records that the
corpus's own `six-cameras` and `two-cameras` archetypes differ in three things at
once, so the gap between them is not the price of four extra photographs. This
design does not repeat that.

### Pairing

At a fixed seed, every level of every axis is the **same rig** — same `d_proj`,
same projector heights, same mount error, same camera stand. `makeScenario`
draws the rig before the archetype's overrides run and none of those draws depend
on anything this package changes. `test/experiment1.test.ts` asserts it rather
than assuming it, because an unpaired sweep measures the difference between
scenarios and calls it a knob.

### Dispersion

Every point runs at several seeds and the spread is reported, never averaged
away. The figures draw the median as an open circle, the observed range as a
whisker, and **every individual seed as a dot**. A median line with no dots is a
claim about a distribution the reader cannot check.

Median rather than mean, because several of these distributions are bias-limited
rather than noise-limited and one bad draw moves a mean of five much further than
it moves the median — the mean is in the JSON beside it so the skew stays
visible. Range rather than a standard error, because at n = 1..5 a standard error
is a number with a confidence interval wider than itself.

---

## The figures

Self-contained SVG, generated from the data, no JavaScript, no external
references. `test/experiment1.test.ts` asserts that last part: a figure that
quietly needs the internet is a figure that will be blank in the room where it
matters.

| File | What it shows |
| --- | --- |
| `progress/experiment-1-camera-count.svg` | Pose position, pose rotation and grid displacement against 1..8 cameras, tripod and handheld |
| `progress/experiment-1-resolution.svg` | The same three against camera resolution, up to a real phone |
| `progress/experiment-1-floor-reference.svg` | The same against the floor-reference instrument, with the quadrature prediction |
| `progress/experiment-1-degradations.svg` | Each degradation condition on its own, against the noiseless reference |

Log axes throughout, because the data spans decades and on a linear axis every
point below 10 mm would sit on the frame. §7's gates are drawn where §7 puts
them, labelled, so a reader does not have to hold the threshold in their head.

---

## Cost, and what the budget cut

Capture is `cameras x projectors x frames x pixels` and dominates everything
else. Measured on this box:

| Configuration | Per seed |
| --- | --- |
| 3 cameras, 320x240, tripod | ~9 s |
| 3 cameras, 640x480, tripod | ~22 s |
| 3 cameras, 1280x960, tripod | ~76 s |
| 3 cameras, 2560x1920, tripod | ~5 min |
| 3 cameras, 4032x3024, tripod | ~12 min |
| any of the above, handheld | roughly 2.5x, because the geometry pass is rebuilt per frame |

`estimateSeconds` carries that model so `--list` prints a budget before a run
rather than after it. The full design is 43 cells, 197 solves, about two hours.

`design.ts:CUTS` lists every place the design is thinner than it should be, why,
and **what it costs the conclusion** — a test asserts all three fields are
present, so a cut cannot be added without saying what it costs. The headline
ones: the 4032x3024 phone point is one seed, tripod only; 2560x1920 is two seeds;
and the resolution axis holds the correspondence cap fixed, so it measures
per-correspondence precision rather than correspondence count. That last one is
not inherited from A-12 on trust — the `cap-control` cells measure it directly.

---

## Determinism and resume

Every point is a pure function of `(spec, seedIndex)`. Completed points are
appended to `progress/experiment-1-runs.jsonl` as they finish and a re-run skips
anything already there, which is safe *because* of that purity: the same key can
only ever produce the same numbers, so resuming cannot silently splice two
different measurements together. Delete the file to force a clean run.

The results file declares its volatile fields — `env` and the wall-clock timings
— in the same form `packages/bench` does, so the same reasoning applies: two runs
of the same command agree on every number that is a measurement.
