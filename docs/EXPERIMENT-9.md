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

**That is still true of the bookends and is only partly true of the mechanism
that followed them.** Experiment 8 has since added a complement fingerprint, and
a straddle is not invisible to it — but the response depends on *which* frame of
a pair the shutter smeared, and an earlier version of this paragraph claimed a
single crossing point that does not exist.

A Gray plane is followed by its own complement, so a photograph that is a
fraction `a` of the pattern and `1 - a` of the frame after it misses the
identity by exactly `1 - a`. The complement is followed by the **next plane**,
not by its own pattern, and two different Gray planes disagree over only half
the raster — so the same straddle there misses by about `(1 - a) / 2`. Measured
on the page's own plan at the required grid, a 15% straddle reads 0.1500 on the
pattern side and 0.0750 on the complement side, and on the finest plane at the
sweep's own grid offset the pattern side falls to 0.0938
(`packages/solver/test/indexing.test.ts` pins both sides).

So at `COMPLEMENT_LIMIT` the crossing into a refusal is **not** one number: it is
about a seventh of the exposure for a straddled pattern on a coarse plane, about
a third for a straddled complement, and further still on the finest planes. A
straddle smaller than that is offered rather than refused.

What is **not** established is how often a straddle is large enough, because the
sweep below was not re-run against the fingerprint. The numbers on this page are
the bookends' exposure, and they are the right numbers for the mechanism they
describe.

## The answer, and it is not the axis this experiment was opened on

The first version of this experiment swept clock drift, found almost nothing,
and concluded that tethering was unjustified. Review found the reason: the start
phase — where in a dwell the operator's first shutter lands — was a constant
buried in the model, drawn from the middle half of the dwell on the reasoning
that "an operator aims at the middle". That excluded every boundary-adjacent
start, which is exactly the risk in question. **The headline was a property of
the sampling rule.**

A second round found a second constant doing the same thing: `FRAMES = 408` was
simulated as one uninterrupted run, when the emitter stops after each camera
position and the operator starts it again. Both corrections are described where
their numbers appear below. Neither was found by writing the model; both were
found by checking it against the code it claims to describe.

It is now an axis. Captures touched at the loosest crystal, 1/4 s exposure:

<!-- generated: experiment-9-phase -->
| first shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| aimed | — | 1767 (88.3%) | 116 (5.8%) | 0 (0.0%) | 0 (0.0%) |
| uniform | — | 1798 (89.9%) | 1198 (59.9%) | 728 (36.4%) | 468 (23.4%) |
| on-tick | — | 1830 (91.5%) | 9 (0.5%) | 13 (0.7%) | 20 (1.0%) |
<!-- /generated -->

Same clocks, same dwell, same exposure. Only where the first shot landed.

A shot opening at phase `p` within a dwell straddles exactly when
`p > dwell − exposure`, so under a start with no procedure behind it the first
frame straddles with probability `exposure / dwell` — **12.5%** at the default
dwell and a 1/4 s exposure — and drift is far too small to move it afterwards.
That number is arithmetic, not simulation, and no crystal improves it.

That is the risk for **one camera position**, and a capture is three of them.
`emit.ts` plans 136 steps and names them *"one camera position"*; `advance()`
stops the sequence when they run out. The operator then moves the tripod and
presses start again, which draws a fresh phase. So the gamble is taken three
times and the capture-level risk is `1 − (1 − exposure/dwell)³` — **33.0%**,
against the **36.4%** measured, the small excess being the starts that drift
into the zone rather than beginning there.

This is the correction review forced on the first version of this experiment,
and it is the same defect as the start phase one level up: `FRAMES = 408` looked
like a frame total and was carrying an assumption about the procedure — that the
whole capture is one uninterrupted run. It is not, and simulating it as one
halved the headline.

Shooting on the page's own tick is materially better, because `emit.ts` plays
its tone **at** the step: a shutter tripped on it opens a reaction time later,
which is near the start of the dwell and so has the whole safe window ahead of
it. The page's existing feedback was doing real work and nobody had noticed.

It is not monotonic, and the reason is worth reading rather than smoothing away.
The `on-tick` row gets **worse** as the dwell lengthens — 0.5% at 1 s, 0.7% at
2 s, 1.0% at 4 s — because a reaction time is absolute while accumulated phase
drift scales with the dwell. Over one position the loosest crystal moves the
shot 13.6 ms at a 1 s dwell, 27.2 ms at 2 s and 54.4 ms at 4 s; the operator is
sitting about 250 ms above the boundary below them, so a longer dwell pushes a
larger slice of the reaction-time distribution back through zero, where it wraps
into the change it was avoiding.

That attribution is measured rather than argued: re-running the row with the
crystal made perfect leaves it **flat** at a few tenths of a percent for every
dwell, which is the wrap of a negative reaction time alone. All of the slope is
drift. Sitting close to a boundary is safe only while nothing moves you.

By shutter arrangement, at a start with no procedure:

<!-- generated: experiment-9-dwell -->
| shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| tethered | — | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| intervalometer-20ppm | — | 1791 (89.5%) | 1216 (60.8%) | 675 (33.8%) | 365 (18.3%) |
| intervalometer-50ppm | — | 1796 (89.8%) | 1196 (59.8%) | 696 (34.8%) | 424 (21.2%) |
| intervalometer-100ppm | — | 1798 (89.9%) | 1198 (59.9%) | 728 (36.4%) | 468 (23.4%) |
| handheld-remote | — | 2000 (100.0%) | 2000 (100.0%) | 1981 (99.0%) | 1530 (76.5%) |
<!-- /generated -->

**Clock drift really is negligible**, which was the first version's one
surviving finding — and the three-position correction strengthens it, since the
accumulation restarts twice. At the default dwell one camera position
accumulates about 27 ms at the loosest crystal, against margins of 750 ms above
a mid-dwell shot and 1000 ms below. (Those margins are asymmetric, and an earlier draft quoted
`(dwell − exposure) / 2` as "slack either side" — that is the half-width of the
safe window, not a margin.)

**The dwell still matters**, because the safe window is `dwell − exposure` wide:
shortening the step shrinks it, and the emitter lets an operator take dwell to
`MIN_DWELL_S`, 0.2 s, with nothing on the page saying what that spends.

**A hand-pressed remote is worse and differently shaped** — see below.

## The shape matters more than the count

<!-- generated: experiment-9-shape -->
| shutter | start | dwell | captures touched | worst capture | worst burst | all runs touched | position lost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| intervalometer-20ppm | aimed | 0.5 s | 1767 / 2000 | 408 / 408 | 136 | 258 | 1706 |
| intervalometer-20ppm | aimed | 1 s | 62 / 2000 | 91 / 408 | 15 | 0 | 0 |
| intervalometer-20ppm | uniform | 0.5 s | 1791 / 2000 | 408 / 408 | 136 | 244 | 1729 |
| intervalometer-20ppm | uniform | 1 s | 1216 / 2000 | 408 / 408 | 136 | 39 | 1138 |
| intervalometer-20ppm | uniform | 2 s | 675 / 2000 | 408 / 408 | 136 | 5 | 618 |
| intervalometer-20ppm | uniform | 4 s | 365 / 2000 | 408 / 408 | 136 | 1 | 324 |
| intervalometer-20ppm | on-tick | 0.5 s | 1819 / 2000 | 408 / 408 | 136 | 297 | 1747 |
| intervalometer-20ppm | on-tick | 1 s | 7 / 2000 | 136 / 408 | 136 | 0 | 5 |
| intervalometer-20ppm | on-tick | 2 s | 6 / 2000 | 136 / 408 | 136 | 0 | 5 |
| intervalometer-20ppm | on-tick | 4 s | 3 / 2000 | 136 / 408 | 136 | 0 | 2 |
| intervalometer-50ppm | aimed | 0.5 s | 1798 / 2000 | 408 / 408 | 136 | 254 | 1719 |
| intervalometer-50ppm | aimed | 1 s | 86 / 2000 | 218 / 408 | 68 | 0 | 0 |
| intervalometer-50ppm | uniform | 0.5 s | 1796 / 2000 | 408 / 408 | 136 | 274 | 1716 |
| intervalometer-50ppm | uniform | 1 s | 1196 / 2000 | 408 / 408 | 136 | 44 | 1118 |
| intervalometer-50ppm | uniform | 2 s | 696 / 2000 | 408 / 408 | 136 | 3 | 617 |
| intervalometer-50ppm | uniform | 4 s | 424 / 2000 | 272 / 408 | 136 | 0 | 341 |
| intervalometer-50ppm | on-tick | 0.5 s | 1806 / 2000 | 408 / 408 | 136 | 277 | 1725 |
| intervalometer-50ppm | on-tick | 1 s | 4 / 2000 | 136 / 408 | 136 | 0 | 3 |
| intervalometer-50ppm | on-tick | 2 s | 12 / 2000 | 136 / 408 | 136 | 0 | 11 |
| intervalometer-50ppm | on-tick | 4 s | 13 / 2000 | 136 / 408 | 136 | 0 | 4 |
| intervalometer-100ppm | aimed | 0.5 s | 1767 / 2000 | 408 / 408 | 136 | 271 | 1690 |
| intervalometer-100ppm | aimed | 1 s | 116 / 2000 | 142 / 408 | 103 | 0 | 0 |
| intervalometer-100ppm | uniform | 0.5 s | 1798 / 2000 | 408 / 408 | 136 | 257 | 1709 |
| intervalometer-100ppm | uniform | 1 s | 1198 / 2000 | 408 / 408 | 136 | 32 | 1053 |
| intervalometer-100ppm | uniform | 2 s | 728 / 2000 | 408 / 408 | 136 | 4 | 589 |
| intervalometer-100ppm | uniform | 4 s | 468 / 2000 | 272 / 408 | 136 | 0 | 319 |
| intervalometer-100ppm | on-tick | 0.5 s | 1830 / 2000 | 408 / 408 | 136 | 264 | 1718 |
| intervalometer-100ppm | on-tick | 1 s | 9 / 2000 | 136 / 408 | 136 | 0 | 3 |
| intervalometer-100ppm | on-tick | 2 s | 13 / 2000 | 136 / 408 | 136 | 0 | 3 |
| intervalometer-100ppm | on-tick | 4 s | 20 / 2000 | 136 / 408 | 136 | 0 | 1 |
| handheld-remote | aimed | 0.5 s | 2000 / 2000 | 243 / 408 | 20 | 2000 | 0 |
| handheld-remote | aimed | 1 s | 2000 / 2000 | 154 / 408 | 9 | 1890 | 0 |
| handheld-remote | aimed | 2 s | 1821 / 2000 | 43 / 408 | 7 | 3 | 0 |
| handheld-remote | aimed | 4 s | 44 / 2000 | 2 / 408 | 1 | 0 | 0 |
| handheld-remote | uniform | 0.5 s | 2000 / 2000 | 242 / 408 | 20 | 2000 | 0 |
| handheld-remote | uniform | 1 s | 2000 / 2000 | 184 / 408 | 12 | 1944 | 0 |
| handheld-remote | uniform | 2 s | 1981 / 2000 | 161 / 408 | 11 | 286 | 0 |
| handheld-remote | uniform | 4 s | 1530 / 2000 | 152 / 408 | 10 | 20 | 0 |
| handheld-remote | on-tick | 0.5 s | 2000 / 2000 | 240 / 408 | 18 | 2000 | 0 |
| handheld-remote | on-tick | 1 s | 2000 / 2000 | 122 / 408 | 8 | 1916 | 0 |
| handheld-remote | on-tick | 2 s | 2000 / 2000 | 107 / 408 | 9 | 1521 | 0 |
| handheld-remote | on-tick | 4 s | 2000 / 2000 | 110 / 408 | 8 | 1465 | 0 |
<!-- /generated -->

The two failure modes have different shapes, and an earlier draft of this page
asserted the stronger one of both. Measured per capture rather than inferred
from maxima taken across different seeds — and, since the three-position
correction, per position within a capture, because that is the unit the failure
actually comes in:

- **A crystal capture loses a whole camera position.** The phase is drawn once
  per position and drift is far too small to walk it out again, so a position
  that starts inside the zone stays there for all 136 of its frames. A touched
  capture puts a median **100%** of its straddles in a single unbroken run, and
  **589 of the 728** touched at the default dwell — four in five — lose at least
  one position from its first photograph to its last. Not all of them: a start
  near the edge of the zone flickers in and out under the 2 ms per-shot jitter.
- **And usually only one.** Most touched captures have one ruined position and
  two clean ones, because the three draws are independent. That is the operator
  fact worth carrying: a night's shooting is not all-or-nothing, it is one
  sitting at the tripod silently thrown away.
- **A handheld capture fails in scattered frames.** Median longest run is about
  **5%** of its straddles, and no position is ever lost end to end. Calling this
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
temperature differ by a roughly constant rate over the few minutes one camera
position takes. The rate is drawn once per capture and not once per position,
since moving the tripod does not give the camera a different oscillator; the
accumulated offset, which does reset, is what restarts. All three choices are stated here so a reader can discount them.

## What it argues for

**This reversed under review, and the reversal is the useful part.** The first
version concluded that a camera SDK was unjustified, on a zero that its own
sampling rule had produced. With the start phase swept instead of assumed, and
with a capture modelled as the three separate emitter runs it actually is, an
operator who starts the camera at no particular phase ruins **more than one
capture in three** at the page's default settings — and cannot tell. Four in
five of those lose a whole camera position, every frame of it.

Both corrections came from review, and both were the same mistake: a number
sitting in the model as a constant, describing a procedure nobody had checked it
against.

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
