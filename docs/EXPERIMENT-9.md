# Experiment 9 — what an open-loop tether costs

`docs/OPERATOR-PATH.md` Phase 5 is the only phase in the plan with **no "Done
when"**. It argues tethering is a convenience now Phase 2 has landed — *the
laptop advances the pattern and trips the shutter* — and that it is deliberately
last because camera SDKs are per-vendor, per-platform and hostile. What it never
says is what the alternative costs.

This is an attempt to put a number on that, so the phase can be given a done-when
about an outcome rather than about a feature existing.

Run it with `npm run experiment9`. It writes `experiments/experiment-9.json`,
which is the measurement; every table below is generated from that file and
checked against it by `npm run check:docs`.

## The hazard is not a dropped frame

`packages/web/web/emit.ts` already advances on a timer with an audible tick,
because *"an operator running the sequence on a timer beside a camera has no way
to know it advanced"*. That is an **open loop**: the projector steps on the
laptop's clock, the shutter fires on the camera's, and neither reads the other.

When they disagree the failure is not a missing photograph. It is a photograph
taken while the projector was **changing** — the shutter open across the
boundary, so the frame holds part of one pattern and part of the next. Call it a
straddle.

A straddle is worse than a drop for one specific reason:

- a **drop** changes the number of photographs, and Phase 2's structural
  bookends catch it by counting between the references;
- a **straddle** changes nothing structural. The count is right, every frame is
  present, and a blend of two patterns still lights about half the crescent —
  which is exactly the property `classify` uses to call a frame *patterned*. The
  bookends see a healthy capture.

`docs/EXPERIMENT-8.md` measured Phase 2's blind spot to be a cancelling
drop-and-duplicate inside one run. This is a second way into the same blind spot,
reached without anybody deleting a file.

## The answer, and it is not the axis this experiment was opened on

The first version of this experiment swept clock drift, found almost nothing,
and concluded that tethering was unjustified. Review found the reason: the start
phase — where in a dwell the operator's first shutter lands — was a constant
buried in the model, drawn from the middle half of the dwell on the reasoning
that "an operator aims at the middle". That excluded every boundary-adjacent
start, which is exactly the risk in question. **The headline was a property of
the sampling rule.**

It is now an axis. Captures touched at the loosest crystal, 1/4 s exposure:

<!-- generated: experiment-9-phase -->
| first shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| aimed | — | 1091 (54.5%) | 83 (4.2%) | 0 (0.0%) | 0 (0.0%) |
| uniform | — | 1120 (56.0%) | 569 (28.4%) | 345 (17.3%) | 247 (12.3%) |
| on-tick | — | 1161 (58.0%) | 4 (0.2%) | 25 (1.3%) | 148 (7.4%) |
<!-- /generated -->

Same clocks, same dwell, same exposure. Only where the first shot landed.

A shot opening at phase `p` within a dwell straddles exactly when
`p > dwell − exposure`, so under a start with no procedure behind it the first
frame straddles with probability `exposure / dwell` — **12.5%** at the default
dwell and a 1/4 s exposure — and drift is far too small to move it afterwards.
That number is arithmetic, not simulation, and no crystal improves it.

Shooting on the page's own tick is materially better, because `emit.ts` plays
its tone **at** the step: a shutter tripped on it opens a reaction time later,
which is near the start of the dwell and so has the whole safe window ahead of
it. The page's existing feedback was doing real work and nobody had noticed.

It is not monotonic, and the reason is worth reading rather than smoothing away.
The `on-tick` row gets **worse** as the dwell lengthens — 0.2% at 1 s, 1.3% at
2 s, 7.4% at 4 s — because a reaction time is absolute while accumulated phase
drift scales with the dwell. At 1 s the drift over a whole capture is 41 ms,
2.6 standard deviations below the 250 ms the operator is sitting at; at 4 s it
is 163 ms, only 1.1 away. The shot walks backwards past the start of the dwell
and wraps into the change it was avoiding. Sitting close to a boundary is safe
only while nothing moves you.

By shutter arrangement, at a start with no procedure:

<!-- generated: experiment-9-dwell -->
| shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| tethered | — | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| intervalometer-20ppm | — | 1039 (52.0%) | 551 (27.6%) | 265 (13.3%) | 113 (5.7%) |
| intervalometer-50ppm | — | 1067 (53.4%) | 558 (27.9%) | 284 (14.2%) | 177 (8.8%) |
| intervalometer-100ppm | — | 1120 (56.0%) | 569 (28.4%) | 345 (17.3%) | 247 (12.3%) |
| handheld-remote | — | 2000 (100.0%) | 2000 (100.0%) | 1727 (86.3%) | 872 (43.6%) |
<!-- /generated -->

**Clock drift really is negligible**, which was the first version's one
surviving finding. At the default dwell a whole capture accumulates about 82 ms
at the loosest crystal, against margins of 750 ms above a mid-dwell shot and
1000 ms below. (Those margins are asymmetric, and an earlier draft quoted
`(dwell − exposure) / 2` as "slack either side" — that is the half-width of the
safe window, not a margin.)

**The dwell still matters**, because the safe window is `dwell − exposure` wide:
shortening the step shrinks it, and the emitter lets an operator take dwell to
`MIN_DWELL_S`, 0.2 s, with nothing on the page saying what that spends.

**A hand-pressed remote is worse and differently shaped** — see below.

## The shape matters more than the count

<!-- generated: experiment-9-shape -->
| shutter | start | dwell | captures touched | worst capture | worst burst | all runs touched | end to end |
| --- | --- | --- | --- | --- | --- | --- | --- |
| intervalometer-20ppm | aimed | 0.5 s | 1054 / 2000 | 408 / 408 | 408 | 1011 | 947 |
| intervalometer-20ppm | aimed | 1 s | 25 / 2000 | 358 / 408 | 133 | 7 | 0 |
| intervalometer-20ppm | uniform | 0.5 s | 1039 / 2000 | 408 / 408 | 408 | 1001 | 934 |
| intervalometer-20ppm | uniform | 1 s | 551 / 2000 | 408 / 408 | 408 | 515 | 480 |
| intervalometer-20ppm | uniform | 2 s | 265 / 2000 | 408 / 408 | 408 | 239 | 226 |
| intervalometer-20ppm | uniform | 4 s | 113 / 2000 | 408 / 408 | 408 | 88 | 81 |
| intervalometer-20ppm | on-tick | 0.5 s | 1078 / 2000 | 408 / 408 | 408 | 1022 | 956 |
| intervalometer-20ppm | on-tick | 1 s | 2 / 2000 | 408 / 408 | 408 | 2 | 2 |
| intervalometer-20ppm | on-tick | 2 s | 2 / 2000 | 408 / 408 | 408 | 2 | 1 |
| intervalometer-20ppm | on-tick | 4 s | 4 / 2000 | 308 / 408 | 267 | 0 | 0 |
| intervalometer-50ppm | aimed | 0.5 s | 1048 / 2000 | 408 / 408 | 408 | 979 | 895 |
| intervalometer-50ppm | aimed | 1 s | 65 / 2000 | 385 / 408 | 340 | 9 | 0 |
| intervalometer-50ppm | uniform | 0.5 s | 1067 / 2000 | 408 / 408 | 408 | 1000 | 944 |
| intervalometer-50ppm | uniform | 1 s | 558 / 2000 | 408 / 408 | 408 | 489 | 454 |
| intervalometer-50ppm | uniform | 2 s | 284 / 2000 | 408 / 408 | 408 | 206 | 193 |
| intervalometer-50ppm | uniform | 4 s | 177 / 2000 | 408 / 408 | 408 | 112 | 105 |
| intervalometer-50ppm | on-tick | 0.5 s | 1130 / 2000 | 408 / 408 | 408 | 1025 | 944 |
| intervalometer-50ppm | on-tick | 1 s | 5 / 2000 | 408 / 408 | 408 | 2 | 2 |
| intervalometer-50ppm | on-tick | 2 s | 8 / 2000 | 408 / 408 | 408 | 2 | 1 |
| intervalometer-50ppm | on-tick | 4 s | 21 / 2000 | 408 / 408 | 408 | 2 | 2 |
| intervalometer-100ppm | aimed | 0.5 s | 1091 / 2000 | 408 / 408 | 408 | 956 | 868 |
| intervalometer-100ppm | aimed | 1 s | 83 / 2000 | 394 / 408 | 375 | 9 | 0 |
| intervalometer-100ppm | uniform | 0.5 s | 1120 / 2000 | 408 / 408 | 408 | 982 | 911 |
| intervalometer-100ppm | uniform | 1 s | 569 / 2000 | 408 / 408 | 408 | 415 | 381 |
| intervalometer-100ppm | uniform | 2 s | 345 / 2000 | 408 / 408 | 408 | 184 | 160 |
| intervalometer-100ppm | uniform | 4 s | 247 / 2000 | 408 / 408 | 408 | 75 | 54 |
| intervalometer-100ppm | on-tick | 0.5 s | 1161 / 2000 | 408 / 408 | 408 | 977 | 888 |
| intervalometer-100ppm | on-tick | 1 s | 4 / 2000 | 408 / 408 | 408 | 1 | 1 |
| intervalometer-100ppm | on-tick | 2 s | 25 / 2000 | 408 / 408 | 408 | 1 | 1 |
| intervalometer-100ppm | on-tick | 4 s | 148 / 2000 | 408 / 408 | 408 | 2 | 1 |
| handheld-remote | aimed | 0.5 s | 2000 / 2000 | 239 / 408 | 17 | 2000 | 0 |
| handheld-remote | aimed | 1 s | 2000 / 2000 | 165 / 408 | 9 | 1904 | 0 |
| handheld-remote | aimed | 2 s | 1458 / 2000 | 75 / 408 | 7 | 166 | 0 |
| handheld-remote | aimed | 4 s | 36 / 2000 | 3 / 408 | 1 | 0 | 0 |
| handheld-remote | uniform | 0.5 s | 2000 / 2000 | 237 / 408 | 19 | 2000 | 0 |
| handheld-remote | uniform | 1 s | 2000 / 2000 | 186 / 408 | 14 | 1946 | 0 |
| handheld-remote | uniform | 2 s | 1727 / 2000 | 182 / 408 | 9 | 888 | 0 |
| handheld-remote | uniform | 4 s | 872 / 2000 | 188 / 408 | 10 | 445 | 0 |
| handheld-remote | on-tick | 0.5 s | 2000 / 2000 | 240 / 408 | 17 | 2000 | 0 |
| handheld-remote | on-tick | 1 s | 2000 / 2000 | 157 / 408 | 8 | 1907 | 0 |
| handheld-remote | on-tick | 2 s | 2000 / 2000 | 148 / 408 | 9 | 1592 | 0 |
| handheld-remote | on-tick | 4 s | 2000 / 2000 | 163 / 408 | 11 | 1542 | 0 |
<!-- /generated -->

The two failure modes have different shapes, and an earlier draft of this page
asserted the stronger one of both. Measured per capture rather than inferred
from maxima taken across different seeds:

- **A crystal capture fails in one concentrated stretch.** The phase moves
  monotonically, so a touched capture puts a median **98%** of its straddles in
  a single run, and a large minority — around 45% of touched captures at the
  default dwell — run from the first frame to the last. Not all of them: a
  capture can drift into the straddle zone partway through, and the 2 ms
  per-shot jitter makes one sitting on the edge flicker in and out, so
  "contiguous" is false as an absolute too.
- **A handheld capture fails in scattered frames.** Median longest run is about
  **5%** of its straddles, and none run end to end. Calling this
  "all-or-nothing" was simply wrong.

What both share is the absence of a signal. Every file is present, every file is
the right size, and the bookends say the run is sound.

## What this does not measure

**What a straddled photograph costs a calibration.** A straddle is counted here
as an event in time — the shutter open across a change — not as a decoded error.
Nothing in this experiment renders a frame or decodes one. Saying *a straddled
frame decodes wrong* would be an argument, and Phase 2's whole lesson was that
this project picks by measurement. That needs its own experiment, with rendered
blends pushed through `decodeCapture`, and until somebody runs it the honest
claim is the narrow one: **this many photographs of a 408-frame capture are not
photographs of the pattern they are filed under.**

**Whether these timing terms are real.** The drift band is engineering-typical
for uncompensated consumer quartz and the jitter figures are plausible for an
intervalometer and a human thumb. Neither has been measured against a camera
standing beside a sphere. The model is also simple on purpose: a fixed rate
error per capture rather than a random walk, because two crystals at steady
temperature differ by a roughly constant rate over the twenty minutes a capture
takes. All three choices are stated here so a reader can discount them.

## What it argues for

**This reversed under review, and the reversal is the useful part.** The first
version concluded that a camera SDK was unjustified, on a zero that its own
sampling rule had produced. With the start phase swept instead of assumed, an
operator who starts the camera at no particular phase ruins about one capture in
six at the page's default settings — and cannot tell.

So there is a real gap, and tethering is one way to close it. What the numbers
say about *which* way:

1. **What a tether removes is the start-phase gamble, not drift.** Drift is
   negligible at any sane dwell. Justifying an SDK on clock accuracy would be
   justifying it on the one thing that is not broken.
2. **The page's tick already closes most of the gap**, because it fires at the
   step and so puts a shutter tripped on it in the roomiest part of the dwell.
   That is nearly free and it is already shipped — it is just not documented as
   load-bearing, and the field card does not tell an operator to use it.
3. **The emitter should say what a short dwell costs**, against the operator's
   own exposure, since the safe window is `dwell − exposure` wide and the page
   knows the dwell.
4. **A hand-pressed remote should be discouraged**, with its number attached.

A tether is the thorough answer and remains the expensive one. The cheap
interventions are worth measuring against it before paying for it — and that
comparison is now possible, which it was not when this phase had no number at
all.
