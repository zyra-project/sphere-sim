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

## The answer

<!-- generated: experiment-9-dwell -->
| shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| tethered | n/a | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| intervalometer-20ppm | n/a | 1067 (53.4%) | 53 (2.6%) | 0 (0.0%) | 0 (0.0%) |
| intervalometer-50ppm | n/a | 1118 (55.9%) | 112 (5.6%) | 0 (0.0%) | 0 (0.0%) |
| intervalometer-100ppm | n/a | 1211 (60.5%) | 180 (9.0%) | 0 (0.0%) | 0 (0.0%) |
| handheld-remote | n/a | 2000 (100.0%) | 2000 (100.0%) | 1442 (72.1%) | 56 (2.8%) |
<!-- /generated -->

Three things fall out of that table, and the first one is the surprise.

**Clock drift is not what breaks an untethered capture.** At the emitter's
default 2 s dwell, a whole 408-frame capture at the loosest plausible crystal
error accumulates about 82 ms — against 875 ms of slack either side of a
mid-dwell shot. It never gets near the boundary. The worry tethering is usually
justified by is not the one that bites.

**What bites is the dwell.** The slack is `(dwell − exposure) / 2`, so it
collapses as an operator shortens the step to get 408 frames done sooner. The
emitter lets them take it to `MIN_DWELL_S`, 0.2 s, with nothing on the page
saying what that spends.

**A hand-pressed remote is a different problem, and it is the one a tether
actually solves.** Even at the default dwell it touches most captures.

## The shape matters more than the count

<!-- generated: experiment-9-shape -->
| shutter | dwell | captures touched | worst capture | worst burst | runs touched | wholly ruined |
| --- | --- | --- | --- | --- | --- | --- |
| intervalometer-20ppm | 0.5 s | 1067 / 2000 | 408 / 408 | 408 | 12595 | 1031 |
| intervalometer-20ppm | 1 s | 53 / 2000 | 367 / 408 | 245 | 425 | 15 |
| intervalometer-50ppm | 0.5 s | 1118 / 2000 | 408 / 408 | 408 | 12865 | 1030 |
| intervalometer-50ppm | 1 s | 112 / 2000 | 390 / 408 | 347 | 797 | 24 |
| intervalometer-100ppm | 0.5 s | 1211 / 2000 | 408 / 408 | 408 | 13678 | 1053 |
| intervalometer-100ppm | 1 s | 180 / 2000 | 401 / 408 | 384 | 1196 | 25 |
| handheld-remote | 0.5 s | 2000 / 2000 | 238 / 408 | 17 | 24000 | 2000 |
| handheld-remote | 1 s | 2000 / 2000 | 166 / 408 | 11 | 23888 | 1894 |
| handheld-remote | 2 s | 1442 / 2000 | 75 / 408 | 6 | 7998 | 198 |
| handheld-remote | 4 s | 56 / 2000 | 4 / 408 | 1 | 71 | 0 |
<!-- /generated -->

Read `worst burst` beside `worst capture`. Where they are equal, the capture was
wrong from its first frame to its last.

That is the real finding. The phase error that decides an open-loop capture is
**fixed for the whole capture** — the start offset does not wander, and drift is
too small to move it — so a capture is not degraded at the edges. It is either
clean or it is ruined, and it was decided at the first frame, silently, by where
the operator happened to start the camera.

An operator whose capture is ruined this way has no signal at all. Every file is
present, every file is the right size, and the bookends say the run is sound.

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

Not, on this evidence, a camera SDK.

A capture shot at the page's default dwell with a $20 intervalometer straddles
nothing across 2 000 simulated captures at the loosest crystal in the sweep. The
expensive, per-vendor, per-platform thing Phase 5 describes buys nothing over
that, for that operator.

What the numbers do argue for is much cheaper, and it is in the page that already
exists:

1. **The emitter should say what a short dwell costs**, and it should say it
   against the operator's own exposure, because the margin is
   `(dwell − exposure) / 2` and the page already knows the dwell.
2. **A hand-pressed remote should be discouraged in the field card**, with the
   number attached: at the default dwell it touches most captures.
3. **Tethering, if it is built, should be justified as the thing that removes the
   start-phase gamble** — not as the thing that fixes clock drift, which is not
   broken.

That is a done-when about an outcome, and Phase 5 did not have one.
