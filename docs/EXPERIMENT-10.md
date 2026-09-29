# Experiment 10 — what a photograph taken across a pattern change costs a calibration

**Status: measured on the bench, against a reader the page does not have yet — and
this is the third full run, because the first said more than it had measured and
the second photographed some clean positions with another camera's noise.**
The first full run's results file (379bb2f) was committed **unverified**, so that
the measurement would not be lost with the container that made it. Adversarial
verification then upheld its measurements but not all of its sentences. Its H7
accounting counted checks that cannot test the identity as failures and as
passes, and called a displacement bound a Gray-flip count. Its verdict set a
straddle's median seam displacement against a re-shoot's 95th percentile, quoted
one classify margin over positions the page had refused for two different
reasons, and inferred what it could have measured: whether a Gray word changes,
what re-shooting only the straddled position costs, and where the card's aimed
start stops protecting. c691f07 corrected those sentences, made the stages measure
those things, and lists the rest in its message. A container restart had already
lost every checkpoint, so the whole run was repeated on the corrected code. Review
of that run found that Q0's fine-raster units, which photograph one camera at a
time, had given the second and third cameras the first camera's sensor noise while
their twins were noised as themselves. 070d7df keys each camera's noise by its
index in the rig, and the run was repeated once more: only those positions
changed, and no figure quoted below moved. **This document reports the last run**:
its tables are generated from the results file, and its prose quotes the same cells.

> **2026-09-29: the page's reader has since been replaced, and this run was not
> repeated.** “Today's page” below is the reader the page had when it ran. The page
> now reads a camera position with `indexPosition`, and on the bench's photographs
> of the 108 clean positions Q0 rendered it refuses none and files no photograph
> under the wrong projector or frame (`experiments/reader-acceptance.json`, and the
> dated notes below). Q0 and its folder shapes stay the record of the reader it
> replaced. The loud and silent
> counts are unchanged as a measurement of the complement check, which the new
> reader runs unchanged, refusing a broken pair in the same words. What that reader
> does with a straddled capture is the rescoring's page column, which a re-run of
> this experiment would now run; nothing here says what it will show.

- **Data** — [`experiments/experiment-10.json`](../experiments/experiment-10.json)
  (`sphere-sim/experiment-10@1`). Every table below is generated from it and checked
  by `npm run check:docs`. The sentence in `verdict.statement` is assembled from its
  cells, and where it quotes a figure the prose below quotes the same one.
- **Reproduce** — `npm run experiment10` runs the stages in order (`q0`, `bank`,
  `gate`, `decode`, `pose`, `rescore`, `lateness`) and then writes the file, resuming
  from the checkpoints in `experiments/.experiment-10-partial/`: about 6½ h in one
  process. `--stage <name>` runs or resumes one stage, so once `q0` and `bank` are
  on disk the other five can run side by side — `pose`, `rescore` and `lateness`
  share a solve file, so start those three together — and `--stage assemble` writes
  the file from finished checkpoints alone. Run as four lanes on 4 CPUs, the last run
  took 2 h 26 min, `rescore` alone 2 h 17 min. `--quick` and `--smoke` check the
  plumbing and never write the committed file.
- **Code** — [`packages/experiments/src/straddle/`](../packages/experiments/src/straddle/)
  (`stages.ts` measures and is fingerprinted; `assemble.ts` writes the document and
  its verdict, and is not), the renderer's straddle hook in
  [`packages/bench/src/capture.ts`](../packages/bench/src/capture.ts), and EXPERIMENT-9's
  shots replayed through `shotTimings` in
  [`packages/experiments/src/tether/run.ts`](../packages/experiments/src/tether/run.ts)

## Registered before the re-run with the page's reader

> **2026-09-29, before the re-run measured anything.** This experiment is being run
> again with the page's new reader, so the rescoring's page column runs at last:
> each straddled camera position handed whole to the page's own reader. These bets
> are recorded before any page-column output of the re-run's code exists. The
> re-run reports each one as held or falsified, and none of them is changed after
> it. The thresholds come from this document's own cells and from the new reader's
> design, not from a look at the column.
>
> - **P10.** In every rescore and lateness cell, a run the page places files
>   every photograph under the step that holds more than half that photograph's
>   exposure. Any content misfile in a placed run, in any cell, falsifies it.
>   Photographs with no majority step are counted apart and cannot falsify it.
> - **P11.** In R1 the page is SILENT on no more of the touched captures than the
>   counterfactual reader is (98 of 728). A page SILENT count above 98 in R1,
>   attributed against the page's own reading of the clean twin, falsifies it.
> - **P12.** A straddle never turns a run the page reads on the clean twin into a
>   note. Any touched run, in any cell, that the clean twin places and the
>   straddled position only notes as out of view or barely seen, with no problem
>   naming it, falsifies it.
> - **P13.** Q0 (the renderer's photographs) and the page's reading of the clean
>   twin (the fast path's) agree at every one of the 108 clean positions: placed,
>   out of view and barely seen equal, and neither with a problem. Any position
>   where they differ falsifies it.
> - **P6** stands as written. The new reader falsifies it by construction, since
>   it places clean positions, and that is what starts the page column.
>
> The re-run also carries three checks on its own harness, which must hold before
> any of the above is read:
> - the page's reading of the clean twin equals
>   `experiments/reader-acceptance.json` at all 108 positions, since the two start
>   from the same photographs;
> - the replaced reader, kept beside the new one in Q0, reproduces this run's Q0
>   field for field;
> - the page reads the fast path's straddled frames as it reads the renderer's
>   (H8).

---

## Why it exists

`docs/EXPERIMENT-9.md` counted how often the shutter is open while the emitter
changes pattern — 728 of 2000 captures at the page's defaults, in the replay this
document scores — and said in as many words that it could not say what one costs:
*"Nothing in this experiment renders a frame or decodes one."* This experiment
renders them, through the bench's own renderer, and hands them to the page's own
code: first its reader as shipped, which stops every clean position short of the
complement check (the first section after the terms), and then that check and the
decoder, told what kind each photograph is. It asks three things of each
straddle, and asks each rather than assuming the answer: does the photograph decode
correctly anyway; is the run refused loudly, and at what smear; or does it pass and
decode wrong, silently, and by how much.

## Terms, and which way each one leans

These terms are this experiment's own. Each one leans, and the lean is stated so a
reader can discount it.

- **Smear, *s*.** The share of one photograph's exposure that fell on a neighbouring
  step: forward onto the next, backward onto the one before. It is exposure time,
  blended before the sensor, on a global shutter unless a rolling readout is named,
  with no DLP sub-frames and no display scan-out. *It leans away from the residual
  the check compares.* A lone straddled Gray plane reads at most its smear (H1),
  while a whole-run forward blend reads, in projector space, `2s/(2−3s)` on pair u0
  and `1.5s/(2−3s)` on the others (H3), so a crossing quoted as a smear is not the
  residual that crossed. And a rolling straddle named by its middle row's smear
  carries more than that on average, because the rows clamp at zero: 0.0736 at a
  middle-row smear of 0.06.
- **Footing.** How the counterfactual reader is told what kind each photograph is,
  since today's page cannot tell it. The *content* footing (primary) observes a
  photograph as the kind of the part holding more than half its exposure; the
  *filed* footing, as the kind of the step it is filed under. Both hand the reader
  exact lit fractions. *They lean toward the reader in what it can recover, and in
  no known direction in how often it fails:* exact classification is what today's
  page lacks, so both are an ideal-classification baseline in EXPERIMENT-8's sense.
  A working classify could place no more than they let the reader place, but a
  misread reference could add a refusal or hide one, so the loud and silent counts
  below are not bounds in either direction.
- **Attributable.** A refused run counts against the straddle only if its *twin* —
  the same capture without the straddle, on the same noise — places it. *It leans
  toward calling a refusal the straddle's own.* The reader refuses runs on the
  clean capture too, mostly projectors the camera cannot see, and says “Re-shoot
  projector N” there as well; so *loud* means loud against a twin the operator never
  sees.
- **Loud and silent.** A capture is LOUD when the reader refuses a touched
  attributable run in any of its positions, which is then REFUSED-ALL (every such
  run refused) or MIXED (some refused, some placed). It is SILENT when nothing is
  refused and at least one position is PLACED, every such run placed.
  INVISIBLE-ONLY captures touch only runs the twin refuses anyway, and UNCHANGED
  ones were flagged by EXPERIMENT-9's count but changed no photograph. *LOUD leans
  toward reassurance:* a loud capture can still carry a position that passed
  silently (LOUD+SILENT), and it is counted once, as loud.
- **D_grid.** How far the straddle moved the seams: `computeGridDisplacement`
  between the twin's and the treated solve's aligned rigs, which share their noise
  and their solve seeds, so the difference is the straddle's alone. *It leans toward
  harm.* It is the worst seam point, not a typical one, and it counts any movement,
  including movement toward the truth. The seam gate against the truth is read
  separately, and a solve whose D_grid is only a lower bound (censored), or whose
  twin already misses the seam gate, is not judged.
- **τ_null.** The 95th percentile of D_grid between the twin and re-shoots of the
  **whole capture**, every camera photographed again under a fresh capture seed,
  with a bootstrap interval resampling rigs. HARMLESS and BIASED are drawn at it. *It
  leans toward harmless:* re-shooting every camera moves the seams more than
  re-shooting one position does, and a 95th percentile is set by the few rigs that
  supply its largest values (the pose table names them).
- **The one-position yardstick.** The same, re-shooting **only the straddled
  position** under the same seeds and keeping every other camera — the remedy the
  page can actually read back. *It leans less far toward harmless than τ_null*,
  being the smaller null, but it still assumes the re-shoot is clean, and a fresh
  start can straddle again.

A straddle's median D_grid is set against each null's **median**, with the 95th
percentile quoted beside it and never in its place. The first full run set a
median against a 95th percentile.

## Today's page never reaches the complement check

**On the bench, today's page refuses every clean camera position before its
complement check runs, so nothing below is what today's page would do.** It
placed none of the 108 clean positions rendered from the card's camera marks: 105
were refused at classify, with a margin of at most 0.148 against the 0.15 classify
needs, and 3 at the run count. The reason is structural (found when this experiment was
designed): `litFractions` normalises across the whole capture, where one
projector's white lights little of a photograph and another's lights most of it,
and within a run the coarse Gray planes light all of the visible crescent or none of
it rather than about half. So classify cannot tell the references from the
patterns, and a position that clears its margin anyway still gets photographs the
wrong kind, finds the wrong number of runs and is refused at the run count.
Classifying each run alone does not rescue it: 0 of the 288 runs of the sweep would
pass, and a run classified alone still gets a median 8 of its frames the wrong
kind. The page's worth report cannot see any of this either: it
prints “Only 1 camera contributed.” for a folder, whatever the folder holds, because
the page reads one camera per folder.

So every loud and silent figure below is the verdict of a **counterfactual
reader**: the page's own complement check, `indexByFingerprint`, handed the lit
fractions a perfect classify would give. It is not a fix anybody has specified. On
the same clean positions it refuses 66 of the 288 runs of the sweep anyway, 64 of
them runs whose projector the camera cannot see, and it would tell the operator
“Re-shoot projector N” on 66 of the 72 positions.

> **2026-09-29: the page's reader now places these positions.** Handed the bench's
> photographs of the same 108 clean positions through the page's own path, the
> reader that replaced this one refuses none and files no photograph under the
> wrong projector or frame. It
> places 327 runs where the counterfactual places 349: the 22 between them are
> grazing runs of 0 to 7 fingerprint blocks lighting 4 to 176 pixels, which it
> notes as barely seen (18) or out of view (4) and does not decode, and which the
> counterfactual passes. Every one of the 80 runs that light no pixel it notes as
> out of view, where the counterfactual refuses each and asks for a re-shoot. Its
> worth report now covers every camera position read since the plan file was
> loaded, so “Only 1 camera contributed.” means that only one has been read. The
> new reader's table is in [`docs/OPERATOR-PATH.md`](OPERATOR-PATH.md), Phase 2,
> generated from `experiments/reader-acceptance.json`; the table below is the
> reader it replaced. What the new reader makes of a straddled position is not
> measured: that is the rescoring's page column, which a re-run of this experiment
> would now run.

The card's own folder shapes cost something without any straddle. Photographs
before the first white frame cost a problem line and nothing else; a dark
photograph after the last step lengthens the last run until it is refused; and a
re-shot run, appended to the position or handed in alone, gets the whole folder
refused, 192 of 192 such folders. That last one matters below, because it is the
remedy the page's own refusal asks for. (The card has since changed: it now says to
delete the photographs taken after the screen goes black, and to re-shoot the whole
position rather than one projector, `docs/CALIBRATE.md`. The measurement stands: it
is what the page does with such folders.)

> **2026-09-29: and it is no longer what the page does with them.** On the designed
> rigs, with the room spill off and on, the page's reader reads each of these
> shapes as its position: 432 of 432 with none, one or three photographs taken
> before Play and none, one or two dark ones after the last step; and every
> run a position places, re-shot and added after the position (150 of 150) or
> played on to the end as the page's own remedy leaves it (150 of 150). A re-shot
> run handed in alone is still refused, now with how to hand it in (150 of 150).
> The card now says to keep every photograph and to re-shoot a spoiled projector
> into the position's own folder before the tripod moves — and still to re-shoot
> the whole position after a straddle, for the straddle's sake
> (`docs/CALIBRATE.md`).

<!-- generated: experiment-10-precondition -->
| clean positions | raster | positions | placed a run | refused at | classify margin (needs 0.15): median · max | runs a per-run classify would rescue |
| --- | --- | ---: | ---: | --- | --- | ---: |
| the sweep | 320×240 | 72 | 0 | classify 70 · run count 2 | 0.048 · 0.201 | 0 of 288 |
| room spill on | 320×240 | 24 | 0 | classify 23 · run count 1 | 0.052 · 0.201 | 0 of 96 |
| the finer preset | 640×480 | 12 | 0 | classify 12 | 0.047 · 0.147 | 0 of 48 |
| **all** | | **108** | **0** | **105 at classify** (margin at most 0.148), 3 at the run count, having cleared classify (margin 0.172–0.201) and found 2 of 4 runs, 0 elsewhere | | |

_What the page’s worth report prints for a clean folder: “Only 1 camera contributed.”_

| the counterfactual reader, clean | runs | placed | refused anyway | of those, invisible | minor | marginal | positions told “Re-shoot projector N” | clean noise floor: median · max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| the sweep | 288 | 222 | 66 | 64 | 19 | 3 | 66 of 72 | 0.0060 · 0.1386 |
| room spill on | 96 | 89 | 7 | 6 | 20 | 0 | 7 of 24 | 0.0067 · 0.0879 |
| the finer preset | 48 | 38 | 10 | 10 | 3 | 0 | 10 of 12 | 0.0031 · 0.0568 |

| folder shapes an operator can produce | positions | runs placed (the plain folder’s) | refused whole | the page’s reasons |
| --- | ---: | --- | ---: | --- |
| leading 0, trailing 0 | 24 | 75 (75) | 0 | unanswered pair 21 |
| leading 0, trailing 1 | 24 | 59 (75) | 0 | run length 24 · unanswered pair 13 |
| leading 0, trailing 2 | 24 | 59 (75) | 0 | run length 24 · unanswered pair 13 |
| leading 1, trailing 0 | 24 | 75 (75) | 0 | photographs before the first white 24 · unanswered pair 21 |
| leading 1, trailing 1 | 24 | 59 (75) | 0 | photographs before the first white 24 · run length 24 · unanswered pair 13 |
| leading 1, trailing 2 | 24 | 59 (75) | 0 | photographs before the first white 24 · run length 24 · unanswered pair 13 |
| leading 3, trailing 0 | 24 | 75 (75) | 0 | photographs before the first white 24 · unanswered pair 21 |
| leading 3, trailing 1 | 24 | 59 (75) | 0 | photographs before the first white 24 · run length 24 · unanswered pair 13 |
| leading 3, trailing 2 | 24 | 59 (75) | 0 | photographs before the first white 24 · run length 24 · unanswered pair 13 |
| projector 1 re-shot and appended | 24 | 0 (75) | 24 | run count 24 |
| projector 1 re-shot alone | 24 | 0 (75) | 24 | run count 24 |
| projector 2 re-shot and appended | 24 | 0 (75) | 24 | run count 24 |
| projector 2 re-shot alone | 24 | 0 (75) | 24 | run count 24 |
| projector 3 re-shot and appended | 24 | 0 (75) | 24 | run count 24 |
| projector 3 re-shot alone | 24 | 0 (75) | 24 | run count 24 |
| projector 4 re-shot and appended | 24 | 0 (75) | 24 | run count 24 |
| projector 4 re-shot alone | 24 | 0 (75) | 24 | run count 24 |
<!-- /generated -->

## Given bookends that can place runs, what a straddle costs

**Most touched captures are refused loudly, and most of what passes silently moves
the seams further than re-shooting would.** This is R1, EXPERIMENT-9's headline cell
replayed shot for shot: the page's defaults (a 2 s dwell and a 1/4 s exposure), an
un-aimed start, EXPERIMENT-9's perfect timer, and policy P, under which a refused
position is re-shot whole and the re-shoot is assumed clean — optimistic, since a
fresh start can straddle again.

Of the 728 touched captures the counterfactual reader refuses 627 loudly, and 31 of
those also carry a position that passed silently. 98 pass silently. Of those,
38 move the worst seam point no further than τ_null
(32–44 across its interval) and 17 move it further, both
without breaking the 1 mm seam gate, and 43 break it, however far they move it;
0 cannot be judged from their solves. Against the one-position
yardstick only 24 are harmless. In all, 61 of the touched
captures end past the seam gate under policy P, counting the loud captures whose
silent position still breaks it. Of the rest, 3 touched only runs the reader
refuses on the clean capture too, and 0 changed no photograph at all.

The other cells change one thing at a time. A hand-pressed remote (R4) touches 495
of 500 captures; the card's aimed start at a perfect timer (R8) touches 0 of 2000.

<!-- generated: experiment-10-rescore -->
| cell | setting (R1 in full; the rest, what differs) | captures touched | LOUD (share, 95% CI) | LOUD+SILENT | SILENT | INVISIBLE-ONLY | UNCHANGED |
| --- | --- | --- | --- | ---: | --- | ---: | ---: |
| R1 | intervalometer-100ppm, uniform start, 1/4 s, perfect timer | 728 of 2000 | 627 (86.1%, 83.7–88.5%) | 31 | 98: 38 harmless, 17 biased, 43 gate-breaking | 3 | 0 |
| R2 | intervalometer-20ppm | 675 of 2000 | 622 (92.1%, 90.0–94.2%) | 13 | 51 placed (not solved) | 2 | 0 |
| R3 | 1/60 s | 163 of 2000 | 131 (80.4%, 73.0–87.6%) | 1 | 17 placed (not solved) | 15 | 0 |
| R4 | handheld-remote | 495 of 500 (1 newly touched) | 482 (97.4%, 96.0–98.6%) | 113 | 11 placed (not solved) | 2 | 0 |
| R5 | 30 ms rolling readout | 801 of 2000 (73 newly touched) | 654 (81.6%, 79.3–84.0%) | 42 | 138 placed (not solved) | 9 | 0 |
| R6 | room spill on | 728 of 2000 | 633 (87.0%, 84.2–89.4%) | 33 | 93 placed (not solved) | 2 | 0 |
| R7 | 60 Hz refresh wait | 760 of 2000 (32 newly touched) | 627 (82.5%, 79.7–85.0%) | 40 | 118 placed (not solved) | 10 | 5 |
| R8 | aimed start | 0 of 2000 | 0 | 0 | 0 placed (not solved) | 0 | 0 |

_Policy P: a refused position is re-shot whole and the re-shoot assumed clean. A LOUD+SILENT capture is LOUD and is not counted again under SILENT._

| the solved cell’s captures | R1, policy P | R1, policy A |
| --- | --- | --- |
| SILENT | 98 | 98 |
| HARMLESS: within τ_null, gate kept (share of touched captures, 95% CI) | 38 (5.2%, 3.5–7.1%) | 38 (5.2%, 3.5–7.1%) |
| BIASED: beyond τ_null, gate kept (share of touched captures, 95% CI) | 17 (2.3%, 1.4–3.5%) | 17 (2.3%, 1.4–3.5%) |
| GATE-BREAKING: seams pushed past 1 mm (share of touched captures, 95% CI) | 43 (5.9%, 4.5–7.3%) | 43 (5.9%, 4.5–7.3%) |
| unjudgeable (D_grid censored, or the twin misses the gate) | 0 | 0 |
| not solved | 0 | 0 |
| judged, and of those beyond τ_null | 98, 60 | 98, 60 |
| HARMLESS if τ_null were its CI’s lower · upper end | 32 · 44 | 32 · 44 |
| HARMLESS against the one-position τ | 24 | 24 |
| past the seam gate: SILENT · LOUD+SILENT · all | 43 · 18 · **61** | 43 · 66 · **109** |
| solved captures: rotation gate flipped · D_grid > 0.25 mm · > 0.5 mm | 129: 49 · 100 · 86 | 193: 77 · 160 · 142 |
| within re-shoot noise, and of those gate-breaking anyway | 48, 0 | 59, 1 |
<!-- /generated -->

## The check refuses a position run by run, not all at once

**Each run of a straddled position crosses the limit at its own smear, so a
position is refused one run at a time and there is no single smear at which it
is.** Forward, the check first refuses a whole-position straddle at between 7.2%
and 16.2% of the exposure — the 10th and 90th percentiles over all 222 attributable
runs; median 11.6%, full range 7.0–16.5%. Backward, between 5.1% and 15.9% (median
11.0%). These come from the noiseless linear predictor, since a blend's fingerprint
is the blend of the fingerprints (T14); with noise on, the verdict agrees with it on
1102 of 1110 run-levels. Encoding to the page's 8-bit sRGB and reading back through
`summarisePhoto` moves a noiseless residual by at most 0.0070 from the linear one,
and by at most 0.0038 on runs that are not minor, so P9, which allowed 0.005, is
**falsified**.

Within one position the runs' forward crossings spread by a median 8.3 points of the
exposure. So between a position's first crossing and its last, some of its runs are
refused and the rest placed, which is what a MIXED position is. What sets a run's
crossing is its **binding pair**, the first pair whose residual crosses the limit,
and that is pair u0 in only 49.1% of runs; the rest bind on a finer plane or a
*v* plane. The closed form built from the quarter masses describes pair u0 alone:
on the runs u0 binds it misses the rendered crossing by at most 0.0002, and its
largest gap, 0.0152, is on the 68 runs whose u0 crossing is above 20%, where pair
u0 decides nothing. P2c, which asked for that gap to stay within 0.005 on every run
lighting at least 1% of the photograph, is **falsified**.

<!-- generated: experiment-10-crossings -->
| where the check first refuses a run | runs | never refused up to 50.0% | min | p10 | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| forward, whole position | 222 | 0 | 7.0% | 7.2% | 11.6% | 16.2% | 16.5% |
| backward, whole position | 222 | 0 | 0.5% | 5.1% | 11.0% | 15.9% | 16.7% |
| forward, room spill on | 89 | 0 | 7.0% | 7.3% | 12.0% | 16.2% | 16.4% |
| spread of one position’s forward crossings | 72 positions | — | 6.0 pts | 7.1 pts | 8.3 pts | 8.8 pts | 9.3 pts |

_Forward, 73.9% of the 222 attributable runs are refused below the 0.15 limit itself; 72 of 72 positions have runs crossing at least 2 points apart. Backward, 22 runs are refused below 5.0%, each lighting at most 1.5% of the photograph, the lowest at 0.45%. With noise on, the verdict agrees with the noiseless predictor on 1102 of 1110 run-levels (99.3%)._

| pair | binds a run’s forward crossing | the pair’s own forward crossing: p10 · median · p90 |
| --- | ---: | --- |
| u0 | 109 (49.1%) | 7.2% · 12.3% · 38.5% |
| u1 | 5 (2.3%) | 11.0% · 20.0% · 26.0% |
| u2 | 70 (31.5%) | 12.3% · 15.0% · 18.6% |
| u3 | 1 (0.5%) | 11.6% · 15.6% · 26.0% |
| u4 | 0 (0.0%) | 12.3% · 15.4% · 20.7% |
| u5 | 11 (5.0%) | 10.5% · 14.5% · 18.8% |
| v0 | 0 (0.0%) | 11.6% · 15.5% · 20.0% |
| v1 | 26 (11.7%) | 15.8% · 16.3% · 17.6% |
| v2 | 0 (0.0%) | 13.3% · 15.8% · 18.5% |
| v3 | 0 (0.0%) | 13.1% · 15.5% · 18.8% |
| v4 | 0 (0.0%) | 13.0% · 15.6% · 19.5% |
| v5 | 0 (0.0%) | 12.9% · 16.3% · 23.1% |

_Pair u0’s quarter-mass closed form against its rendered crossing: largest gap 0.0002 on the 99 runs u0 binds, 0.0002 on the 120 runs whose u0 crossing is at most 20.0%, and 0.0152 on the 68 above it._
<!-- /generated -->

## What passes is a phase bias, not a wrong fringe

**What the check lets through keeps its Gray words and carries a phase bias whose
mean is one-signed.** At every smear decoded without noise, up to s = 0.5, not one
of the 21235629 pixels both decodes accept changed its Gray address: a straddle
shifts a decode's phase and leaves its Gray word alone, and past the Gray onsets it
loses pixels rather than misreading them. The bias is about 0.75 of
`atan2(s, 1−s)·P/2π`, toward lower projector coordinates for a forward straddle, and
every run's mean is negative on both axes at every forward smear decoded. At
s = 0.06 that is 0.46 px along *u* and 0.26 px along *v* at the 1920×1080 raster,
the medians over 67 runs of each run's mean, and on the sphere a median 1.17 mm
counting both axes (the median of per-run medians, which span 0.95–2.72 mm).

One-signed in its mean is not one-signed per pixel. No pixel moves positive along
*u*; along *v*, 15.1% of the 225994 pixels where the next projector also lights move
positive, against 0.008% of the 879834 others, and |Δv| reaches 2.03 px against a
mean of 0.26 px. The seam is where the blend brings another projector's light into
the run, and it is where the sign breaks.

H7's accounting is the corrected one: a check on a run whose clean decode accepts no
pixel of the half it asks about cannot test the identity, and is counted apart, not
as a pass or a failure. The 5/9 onset of confident flips is not bracketed, because
nothing above s = 0.5 was decoded: what is measured is their absence below it.

<!-- generated: experiment-10-decode -->
| straddle | s | runs | mean Δu, px | mean Δv, px | Δ ÷ cyclic shift: u · v | Gray words changed: u · v, of pixels compared | moved ½ period or more | on the sphere, mm |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| forward | 0.01 | 67 | -0.07 | -0.04 | -0.750 · -0.750 | 0 · 0, of 1105828 | 0 | 0.19 |
| forward | 0.02 | 67 | -0.15 | -0.08 | -0.750 · -0.750 | 0 · 0, of 1105828 | 0 | 0.38 |
| forward | 0.05 | 67 | -0.38 | -0.21 | -0.751 · -0.750 | 0 · 0, of 1105828 | 0 | 0.97 |
| forward | **0.06** | 67 | **-0.46** | **-0.26** | -0.751 · -0.750 | 0 · 0, of 1105828 | 0 | **1.17** |
| forward | 0.1 | 67 | -0.79 | -0.45 | -0.752 · -0.751 | 0 · 0, of 1105828 | 0 | 2.04 |
| forward | 0.15 | 67 | -1.26 | -0.71 | -0.754 · -0.753 | 0 · 0, of 1105598 | 0 | 3.23 |
| forward | 0.2 | 67 | -1.77 | -1.00 | -0.757 · -0.757 | 0 · 0, of 1104774 | 0 | 4.55 |
| forward | 0.3 | 67 | -2.97 | -1.67 | -0.768 · -0.768 | 0 · 0, of 1099554 | 0 | 7.62 |
| forward | 0.4 | 67 | -4.43 | -2.49 | -0.789 · -0.788 | 0 · 0, of 1090528 | 0 | 11.20 |
| forward | 0.43 | 67 | -4.91 | -2.76 | -0.796 · -0.796 | 0 · 0, of 538189 | 0 | 11.43 |
| forward | 0.45 | 67 | -5.25 | -2.97 | -0.801 · -0.806 | 0 · 0, of 502184 | 1 | 11.93 |
| forward | 0.5 | 67 | -6.22 | -4.26 | -0.829 · -1.009 | 0 · 0, of 290 | 0 | 12.87 |
| backward | 0.01 | 67 | 0.07 | 0.04 | 0.750 · 0.750 | 0 · 0, of 1105825 | 0 | 0.19 |
| backward | 0.02 | 67 | 0.15 | 0.08 | 0.750 · 0.750 | 0 · 0, of 1105825 | 0 | 0.38 |
| backward | 0.05 | 67 | 0.38 | 0.21 | 0.751 · 0.750 | 0 · 0, of 1105822 | 0 | 0.98 |
| backward | 0.1 | 67 | 0.79 | 0.45 | 0.751 · 0.751 | 0 · 0, of 1105816 | 0 | 2.07 |
| backward | 0.15 | 67 | 1.26 | 0.71 | 0.753 · 0.753 | 0 · 0, of 1105811 | 0 | 3.28 |
| backward | 0.2 | 67 | 1.77 | 1.00 | 0.757 · 0.757 | 0 · 0, of 1105790 | 0 | 4.63 |
| backward | 0.3 | 67 | 2.97 | 1.67 | 0.768 · 0.768 | 0 · 0, of 1103359 | 0 | 7.71 |
| backward | 0.4 | 67 | 4.43 | 2.49 | 0.789 · 0.788 | 0 · 0, of 1074524 | 0 | 11.38 |
| backward | 0.43 | 67 | 4.91 | 2.77 | 0.796 · 0.797 | 0 · 0, of 754508 | 0 | 11.93 |
| backward | 0.45 | 67 | 5.25 | 2.96 | 0.802 · 0.803 | 0 · 0, of 697955 | 0 | 12.38 |
| backward | 0.5 | 67 | 3.88 | 4.15 | 0.517 · 0.983 | 0 · 0, of 137 | 0 | 8.14 |

_Mean Δ is the median over runs of each run’s mean; the ratio divides it by `atan2(s, 1−s)·P/2π`; millimetres are the median of per-run medians, both axes together. Forward run-levels whose mean is not negative: 0 along u and 0 along v, of 804. Gray words changed below 5/9, every run and level: 0 of 21235629 pixels compared._

| per pixel, forward s = 0.06 | pixels | Δu > 0 | Δv > 0 | largest Δu, px | largest Δv, px |
| --- | ---: | ---: | ---: | ---: | ---: |
| where the next projector also lights (the seam) | 225994 | 0 (0%) | 34176 (15.1%) | 0.69 | 2.03 |
| everywhere else | 879834 | 0 (0%) | 66 (0.008%) | 0.69 | 0.39 |
| all | 1105828 | 0 (0%) | 34242 (3.1%) | 0.69 | 2.03 |

_At s = 0.06, over 67 runs: |mean Δu| 0.46 px and |mean Δv| 0.26 px (medians); the largest run’s 95th percentile of |Δv| 1.44 px; on the sphere 1.17 mm, per-run medians spanning 0.95–2.72 mm._

| H7, noiseless | checks | testable | untestable | failures |
| --- | ---: | ---: | ---: | ---: |
| Gray-ambiguous from 3/7 on the MSB-dark half | 415 | 335 | 80 | 0 |
| no Gray word changed below 5/9 | 1541 | 1541 | 0 | 0 |
| the MSB-lit half lost to low modulation at s = 0.5 | 67 | 55 | 12 | 0 |

_H7 holds. The 5/9 flip onset is not bracketed: the highest smear decoded is s = 0.5. Decodes moved half a period or more below 5/9, a displacement bound and not a flip count: 1._
<!-- /generated -->

## What the bias does to a solve

**A forward straddle at s = 0.06 moves the worst seam point 4.0 times as far as
re-shooting the whole capture does, and 6.8 times as far as re-shooting only the
straddled position.** Solved through the bench on each designed rig, the straddled
camera changing from rig to rig, the median D_grid at that smear is 1.36 mm over
8 rigs (range 0.80–1.94 mm). Re-shooting the whole capture moves it
by a median 0.34 mm (95th percentile 0.69 mm, 95% CI 0.44–0.75);
re-shooting only the position, by a median 0.20 mm (95th percentile
0.33 mm, 95% CI 0.26–0.36).

The gates say the same in counts. At s = 0.06 the 1 mm seam gate flips in 6
of 8 cases and the 0.05° rotation gate in 7; clean whole-capture
re-shoots flip them in 0 of 80 and 16 of
80. P3, the pre-registered bet that at the smallest straddle solved,
s = 0.03, no more than 2 of the 8 cases stay within τ_null, and that at s = 0.06
the seam gate flips in at least 4, is **falsified**: at s = 0.03, 3 of
8 stay within τ_null. P5a, the bet that a rolling shutter moves the crossing little
and costs about what a global one does at the same middle-row smear, is **falsified**:
the rolling arm costs more, and part of that is a dose larger than its name.

<!-- generated: experiment-10-pose -->
| re-shot against the plain twin | re-shoots | median D_grid, mm | 95th percentile (τ), mm | τ's 95% CI | seam gate (1 mm) flipped | rotation gate (0.05°) flipped |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| the whole capture (τ_null) | 80 | 0.34 | 0.69 | 0.44–0.75 | 0 of 80 | 16 of 80 |
| only the straddled position | 80 | 0.20 | 0.33 | 0.26–0.36 | 0 of 80 | 20 of 80 |

_τ_null is set by the rigs supplying its largest 8 values: rig 9 (5), rig 18 (3)._

| designed straddle | solved, of cases | D_grid, mm: median [range] | × the re-shoot medians: whole · position | beyond τ: whole · position | seam gate flipped | rotation gate flipped |
| --- | --- | --- | --- | --- | ---: | ---: |
| forward, s = 0.03 | 8 of 8 | 0.86 [0.40–1.06] | 2.5× · 4.3× | 5 · 8 | 1 of 8 | 4 of 8 |
| forward, s = 0.06 | 8 of 8 | 1.36 [0.80–1.94] | 4.0× · 6.8× | 8 · 8 | 6 of 8 | 7 of 8 |
| forward, s = 0.09 | 8 of 8 | 1.81 [1.24–2.18] | 5.4× · 9.0× | 8 · 8 | 7 of 8 | 5 of 8 |
| forward, s = 0.12 | 8 of 8 | 2.21 [1.22–2.83] | 6.5× · 11.0× | 8 · 8 | 7 of 8 | 4 of 8 |
| forward, s = 0.15 | 6 of 8 (2 all refused) | 2.42 [1.38–3.23] | 7.2× · 12.1× | 6 · 6 | 5 of 8 | 3 of 8 |
| backward, s = 0.03 | 8 of 8 | 0.74 [0.40–1.28] | 2.2× · 3.7× | 4 · 8 | 2 of 8 | 4 of 8 |
| backward, s = 0.06 | 8 of 8 | 1.22 [0.82–2.08] | 3.6× · 6.1× | 8 · 8 | 7 of 8 | 8 of 8 |
| backward, s = 0.09 | 8 of 8 | 1.88 [1.22–2.36] | 5.6× · 9.4× | 8 · 8 | 8 of 8 | 7 of 8 |
| backward, s = 0.12 | 6 of 8 (2 all refused) | 2.75 [1.36–3.04] | 8.2× · 13.8× | 6 · 6 | 6 of 8 | 5 of 8 |
| rolling, ρ/E = 0.3, s̄ = 0.06 | 8 of 8 | 1.84 [1.38–3.05] | 5.4× · 9.2× | 8 · 8 | 8 of 8 | 8 of 8 |
| rolling, ρ/E = 0.3, s̄ = 0.12 | 8 of 8 | 2.15 [1.40–3.05] | 6.4× · 10.7× | 8 · 8 | 7 of 8 | 5 of 8 |
<!-- /generated -->

## The emitter is not a perfect timer, and the aimed rule depends on how late it runs

**The card's aimed start protects only while the emitter runs less than about 3.50
to 3.70 ms late per step, and the only figures for that lateness, from a headless
browser, are 7.5 ms and about 9.3 ms.** The page's `advance()` re-arms its timer
only after it has painted the next frame, so each step starts late by the time that
took, and the lateness accumulates over a position. The aimed start's margin is the
lower edge of its aim band, 0.5 s, spread over the 135 steps after the first:
3.70 ms per step with matched clocks, and 3.50 ms when the camera's clock runs
100 ppm fast. Swept on timing alone, the first aimed capture is touched at 3.5 ms and 1% of
them from 3.6 ms, a crossing the sweep finds in (3.55, 3.6] ms; with a 60 Hz refresh
wait, (3.45, 3.5].

7.5 ms per step is the mean of a design-time probe in a headless browser rendering
in software, in HUD mode with the tick off; armed with the tick on, the same setup
ran about 9.3 ms late when the first run's verification re-ran it. **No stage of
this experiment measures either**, and a display machine's lateness is unmeasured.
At 7.5 ms, 1786 of 2000 aimed captures are touched: 1358 loud, 349 of them also carrying
a silent position; 324 silent, 23 of them solved and 17 of those past the seam gate;
and 104 touching only runs that are refused anyway. At 2 ms per step, a design-time
estimate of the page's script alone with no paint, none of the 2000 is touched.

Lateness also changes the shape of a straddle. At a perfect timer, 712 of the 849
touched positions of an un-aimed start straddle from their first photograph to
their last; from 3 ms per step, none do. The whole-position straddle becomes a slip
that begins part-way through a position and sweeps across it, and the two footings
stop agreeing: at 7.5 ms the aimed cell has 1433 REFUSED-ALL positions on the content
footing against 1263 on the filed one.

<!-- generated: experiment-10-lateness -->
| δ, ms per step | aimed (of 2000) | aimed, 60 Hz wait (of 2000) | uniform (of 2000) | uniform, 60 Hz wait (of 2000) | handheld-remote, uniform (of 500) | uniform: positions touched · whole |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 (0.0%) | 0 (0.0%) | 728 (36.4%) | 756 (37.8%) | 495 (99.0%) | 849 · 712 |
| 1 | 0 (0.0%) | 0 (0.0%) | 947 (47.3%) | 964 (48.2%) | 492 (98.4%) | 1169 · 325 |
| 2 | 0 (0.0%) | 0 (0.0%) | 1222 (61.1%) | 1237 (61.9%) | 494 (98.8%) | 1605 · 8 |
| 3 | 0 (0.0%) | 0 (0.0%) | 1395 (69.8%) | 1399 (70.0%) | 497 (99.4%) | 1977 · 0 |
| 3.4 | 0 (0.0%) | 1 (0.1%) | 1456 (72.8%) | 1469 (73.5%) | 498 (99.6%) | 2131 · 0 |
| 3.45 | 0 (0.0%) | 8 (0.4%) | 1467 (73.4%) | 1467 (73.4%) | 499 (99.8%) | 2155 · 0 |
| 3.5 | 2 (0.1%) | 28 (1.4%) | 1474 (73.7%) | 1483 (74.2%) | 500 (100.0%) | 2172 · 0 |
| 3.55 | 18 (0.9%) | 48 (2.4%) | 1483 (74.2%) | 1497 (74.9%) | 500 (100.0%) | 2189 · 0 |
| **3.6** | 39 (1.9%) | 66 (3.3%) | 1492 (74.6%) | 1504 (75.2%) | 500 (100.0%) | 2212 · 0 |
| 3.65 | 62 (3.1%) | 89 (4.5%) | 1505 (75.3%) | 1517 (75.8%) | 500 (100.0%) | 2229 · 0 |
| 3.7 | 77 (3.9%) | 114 (5.7%) | 1515 (75.8%) | 1527 (76.3%) | 500 (100.0%) | 2250 · 0 |
| 3.75 | 96 (4.8%) | 133 (6.7%) | 1525 (76.3%) | 1538 (76.9%) | 500 (100.0%) | 2269 · 0 |
| 3.8 | 123 (6.2%) | 148 (7.4%) | 1537 (76.8%) | 1543 (77.1%) | 500 (100.0%) | 2298 · 0 |
| 3.85 | 142 (7.1%) | 171 (8.6%) | 1546 (77.3%) | 1555 (77.8%) | 500 (100.0%) | 2318 · 0 |
| 3.9 | 153 (7.6%) | 214 (10.7%) | 1555 (77.8%) | 1555 (77.8%) | 500 (100.0%) | 2345 · 0 |
| 3.95 | 192 (9.6%) | 255 (12.8%) | 1562 (78.1%) | 1562 (78.1%) | 500 (100.0%) | 2366 · 0 |
| 4 | 235 (11.8%) | 292 (14.6%) | 1567 (78.3%) | 1573 (78.6%) | 500 (100.0%) | 2381 · 0 |
| 5 | 911 (45.6%) | 949 (47.4%) | 1691 (84.5%) | 1693 (84.7%) | 500 (100.0%) | 2791 · 0 |
| 6 | 1360 (68.0%) | 1399 (70.0%) | 1784 (89.2%) | 1789 (89.5%) | 500 (100.0%) | 3190 · 0 |
| 7.5 | 1786 (89.3%) | 1798 (89.9%) | 1884 (94.2%) | 1879 (94.0%) | 500 (100.0%) | 3774 · 0 |
| 10 | 1987 (99.4%) | 1987 (99.4%) | 1977 (98.9%) | 1975 (98.8%) | 500 (100.0%) | 4786 · 0 |
| 15 | 2000 (100.0%) | 2000 (100.0%) | 2000 (100.0%) | 2000 (100.0%) | 500 (100.0%) | 6000 · 0 |

_Derived from the design: the aim band’s lower edge, 0.5 s, spread over 135 steps is 3.70 ms per step with matched clocks, and 3.50 ms with the camera’s clock 100 ppm fast. Swept on this grid, on timing alone: the first aimed capture is touched at 3.5 ms and 1% from 3.6 ms, a crossing in (3.55, 3.6] ms; with a 60 Hz refresh wait, the first aimed capture is touched at 3.4 ms and 1% from 3.5 ms, a crossing in (3.45, 3.5] ms._

| rendered | setting | captures flagged or changed | LOUD (share, 95% CI) | of which run by run | LOUD+SILENT | SILENT | INVISIBLE-ONLY | UNCHANGED | past the seam gate |
| --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| L-aimed-2 | intervalometer-100ppm, aimed start, 1/4 s, emitter 2 ms late per step | 0 of 2000 | 0 | 0 | 0 | 0 placed (not solved) | 0 | 0 | — |
| L-uniform-2 | intervalometer-100ppm, uniform start, 1/4 s, emitter 2 ms late per step | 1249 of 2000 (521 newly touched) | 912 (73.0%, 70.7–75.3%) | 637 | 108 | 240 placed (not solved) | 70 | 27 | — |
| L-aimed-7.5 | intervalometer-100ppm, aimed start, 1/4 s, emitter 7.5 ms late per step | 1786 of 2000 (1786 newly touched) | 1358 (76.0%, 73.8–78.1%) | 1358 | 349 | 324: 4 harmless, 2 biased, 17 gate-breaking, 301 not solved | 104 | 0 | 28 under P; 40 of the 58 solved under A |
| L-uniform-7.5 | intervalometer-100ppm, uniform start, 1/4 s, emitter 7.5 ms late per step | 1893 of 2000 (1165 newly touched) | 1693 (89.4%, 88.1–90.8%) | 1637 | 328 | 116 placed (not solved) | 75 | 9 | — |
<!-- /generated -->

## What the page tells the operator

**When the reader refuses a run on its own, it mostly blames a dropped and a
duplicated frame, which is not what happened, and asks for a remedy the page
cannot read back.** Of R1's 627 loud captures, 332 are refused only as whole
positions — “Found N projector runs” — and re-shooting that position is a remedy
the page reads. The other 295 are refused run by run: 295 of them are told “Re-shoot
projector N”, and 295 that the photographs look like a dropped frame and a
duplicated one. That is not what happened, and the
remedy is one the page cannot read back: a folder holding a re-shot run, appended or
alone, is refused whole (192 of 192 in the first section's folder table), so the
page's own advice, and the card's advice to keep both runs, produce a folder it
cannot read. (The card has since changed: it now says to re-shoot the whole
position, `docs/CALIBRATE.md`. The page's refusal still says “Re-shoot
projector N”.)

> **2026-09-29: the page reads that remedy now, and after a straddle it is still
> the wrong one.** The page's reader reads a re-shot run added to the position's
> folder, or played on to the end, in place of the original (the first section's
> notes), and its refusal now says how to hand one in. But a straddle smears the
> whole position and each run crosses the check at its own smear (the section on
> crossings), so the runs that passed can carry the same smear silently, and
> re-shooting only the projector named keeps them. The card says to re-shoot one
> projector into the same folder for a frame spoiled on its own, before the tripod
> moves, and the whole position, aimed, after a straddle. The refusal still blames
> a dropped and a duplicated frame. Whether the new reader refuses a straddled run
> where the counterfactual does is the rescoring's page column, not yet run.

A silent position gets no message at all. Under policy A, which keeps a MIXED
position's placed runs because that is what the page decodes, 97 of R1's loud
captures also carry a silent part — a PLACED position, or the placed runs of a MIXED
one — against 31 under policy P, which counts only PLACED positions.

<!-- generated: experiment-10-positions -->
| cell | footing, runs counted | touched positions | REFUSED-ALL | MIXED | PLACED | INVISIBLE-ONLY | UNCHANGED |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| R1 | content, all | 849 | 638 | 71 | 136 | 4 | 0 |
|  | content, minor & marginal left out | 849 | 638 | 69 | 138 | 4 | 0 |
|  | filed, all | 849 | 638 | 71 | 136 | 4 | 0 |
| R2 | content, all | 782 | 646 | 67 | 65 | 4 | 0 |
|  | content, minor & marginal left out | 782 | 646 | 66 | 66 | 4 | 0 |
|  | filed, all | 782 | 646 | 67 | 65 | 4 | 0 |
| R3 | content, all | 168 | 94 | 40 | 18 | 16 | 0 |
|  | content, minor & marginal left out | 168 | 98 | 36 | 17 | 17 | 0 |
|  | filed, all | 168 | 95 | 39 | 18 | 16 | 0 |
| R4 | content, all | 1157 | 834 | 160 | 132 | 31 | 0 |
|  | content, minor & marginal left out | 1157 | 831 | 141 | 134 | 51 | 0 |
|  | filed, all | 1157 | 808 | 183 | 135 | 31 | 0 |
| R5 | content, all | 946 | 688 | 57 | 190 | 11 | 0 |
|  | content, minor & marginal left out | 946 | 688 | 55 | 192 | 11 | 0 |
|  | filed, all | 946 | 688 | 57 | 190 | 11 | 0 |
| R6 | content, all | 849 | 637 | 78 | 131 | 3 | 0 |
|  | content, minor & marginal left out | 849 | 642 | 65 | 138 | 4 | 0 |
|  | filed, all | 849 | 637 | 78 | 131 | 3 | 0 |
| R7 | content, all | 893 | 625 | 82 | 164 | 14 | 8 |
|  | content, minor & marginal left out | 893 | 625 | 78 | 168 | 14 | 8 |
|  | filed, all | 893 | 625 | 82 | 164 | 14 | 8 |
| R8 | content, all | 0 | 0 | 0 | 0 | 0 | 0 |
|  | content, minor & marginal left out | 0 | 0 | 0 | 0 | 0 | 0 |
|  | filed, all | 0 | 0 | 0 | 0 | 0 | 0 |
| L-aimed-2 | content, all | 0 | 0 | 0 | 0 | 0 | 0 |
|  | content, minor & marginal left out | 0 | 0 | 0 | 0 | 0 | 0 |
|  | filed, all | 0 | 0 | 0 | 0 | 0 | 0 |
| L-uniform-2 | content, all | 1652 | 627 | 477 | 366 | 135 | 47 |
|  | content, minor & marginal left out | 1652 | 674 | 424 | 370 | 137 | 47 |
|  | filed, all | 1652 | 485 | 619 | 366 | 135 | 47 |
| L-aimed-7.5 | content, all | 3141 | 1433 | 429 | 782 | 497 | 0 |
|  | content, minor & marginal left out | 3141 | 1503 | 349 | 776 | 513 | 0 |
|  | filed, all | 3141 | 1263 | 527 | 854 | 497 | 0 |
| L-uniform-7.5 | content, all | 3833 | 1389 | 1428 | 486 | 471 | 59 |
|  | content, minor & marginal left out | 3833 | 1554 | 1252 | 489 | 479 | 59 |
|  | filed, all | 3833 | 1897 | 891 | 515 | 471 | 59 |

_Content footing (primary): a photograph observes as the kind of the part holding more than half its exposure. Filed footing: as the kind of the step it is filed as. Rows are the cells of the two tables above: R1–R8 as re-scored, then each rendered lateness._

| cell | LOUD | refused only as whole positions: “Found N projector runs” | refused run by run | of those, told “Re-shoot projector N” | told it looks like a dropped and a duplicated frame |
| --- | ---: | ---: | ---: | ---: | ---: |
| R1 | 627 | 332 | 295 | 295 | 295 |
| R2 | 622 | 307 | 315 | 315 | 315 |
| R3 | 131 | 54 | 77 | 77 | 66 |
| R4 | 482 | 131 | 351 | 351 | 351 |
| R5 | 654 | 366 | 288 | 288 | 288 |
| R6 | 633 | 333 | 300 | 300 | 300 |
| R7 | 627 | 317 | 310 | 310 | 310 |
| R8 | 0 | 0 | 0 | 0 | 0 |
| L-aimed-2 | 0 | 0 | 0 | 0 | 0 |
| L-uniform-2 | 912 | 275 | 637 | 637 | 556 |
| L-aimed-7.5 | 1358 | 0 | 1358 | 1358 | 806 |
| L-uniform-7.5 | 1693 | 56 | 1637 | 1637 | 880 |
<!-- /generated -->

## What this does not measure

- **A real sphere.** Everything is bench photometry: flat albedo, constant ambient,
  Gaussian shot noise, point-sampled patterns, a single grey channel, no defocus and
  no JPEG. The classify margins, the clean residual floors and the invisible-run
  refusals are bench numbers.
- **A working page.** Every loud/silent split is a counterfactual reader's. Today's
  page refuses every clean position before the check runs (P6), so no straddled
  capture was put through it; once the page can place a clean position, the
  rescoring's page column has to be run. A classify fix must stop classifying Gray
  planes by lit fraction, and the run count must allow for a projector the camera
  cannot see.

  > **2026-09-29: the page can place a clean position now.** Its reader was
  > replaced by one that finds runs without classifying the capture and notes a
  > projector out of sight, the two things this item asks for, and on the bench's
  > photographs it places every clean position Q0 rendered without a refusal
  > (`experiments/reader-acceptance.json`). So the rescoring's page column is the
  > next run; until it is made, every loud/silent split here is still the
  > counterfactual's.
- **The display machine's timing.** The emitter's lateness was never measured here:
  the emitter-timing probe its design called for (`tools/emitter-timing.ts`) was never built, so 7.5 ms is a
  design-time headless figure and every lateness in this document is an input, not a
  result. No sentence about the aimed start stands without the lateness beside it.
- **The camera side.** A folder is exactly its 136 photographs (the card's own extra
  end photographs are measured apart, in the first section's folder table);
  EXPERIMENT-9's drift band, per-shot jitter and start procedures, and the aimed
  start's aim band, are inherited and not validated; hand jitter is assumed
  symmetric; an intervalometer's own re-arm rule is not modelled.
- **Placement.** 24 azimuth offsets of one camera set, one height and distance draw per
  rig, the 3 cameras exactly 120° apart. The results file carries no camera azimuth
  or clearance, so nothing is reported by clearance bin and a site cannot place itself
  by one. A flipped or ceiling-mounted projector mirrors the azimuth dependence.
- **Per-frame repeatability and tone curves**, which are sensitivities under assumed
  values, not measurements. **DLP sub-frames and display scan-out**, which are not
  modelled: sub-frames matter at the 1/60 s exposure, where the short-exposure check
  uses the idealised model.
- **Pose, as the page sees it.** The pose cost is the bench solver's. The page never
  solves, and its worth report cannot see a straddle.
- **A re-shoot that straddles again.** Policy P assumes every re-shoot after a
  refusal is clean.
- **The Gray flip onset at 5/9; the successor ablation proper**, since the ablation
  run dims every photograph instead of replacing only the last one's successor; **and
  the sRGB page path on noisy frames**, which was compared on noiseless blends only.
- **Resolution.** The main sweep renders at 320×240, where a fingerprint cell holds
  about 19 pixels; the finer check bounds only the gate side of that.
- **Most lateness captures' harm.** Only the aimed start at the headless figure is
  solved, and only a subsample of its captures under policy A, so the lateness
  cells' past-gate counts cover the solved captures alone.

## What it decides

**First, the reader.** Today's page places no clean bench position, so nothing about
straddles matters on it until it can. Two things stand in the way: a classify that
relies on a patterned frame lighting about half the crescent, which a coarse Gray
plane does not, and a run count that expects a run from every projector, which a
camera cannot always see: of the counterfactual reader's 66 refusals on clean
positions, 64 are runs of a projector out of sight.

**With a reader that can place runs, a straddle is mostly loud, and the message is
wrong.** A run refused on its own is mostly blamed on a dropped and a duplicated
frame, and the refusal asks for a remedy that produces a folder the page refuses
whole. The only remedy the page reads back is re-shooting the whole position, and
the refusal text and the card's “keep both runs” should say so. That is recorded
here and not acted on. (The card now says to re-shoot the position:
`docs/CALIBRATE.md`. The refusal text still says “Re-shoot projector N”.)

> **2026-09-29: the first is done on the bench; the second is not.** The page's
> reader has been replaced with one that finds each run by what it shows and notes
> a projector out of sight. On the bench's photographs of every clean position Q0
> rendered it refuses nothing and misfiles nothing, and it places 327 runs to the
> counterfactual's 349,
> the 22 between them grazing runs it notes and does not decode
> (`experiments/reader-acceptance.json`). It also reads a re-shot run added to the
> folder, so re-shooting the whole position is no longer the only remedy the page
> reads back; after a straddle it is still the right one, for the straddle's sake,
> and the card says so. The refusal still says “Re-shoot projector N”, now with how
> to hand the re-shoot in. The loud and silent counts above stay the
> counterfactual's; what the new reader does with a straddled capture is what a
> re-run of this experiment, with the rescoring's page column, will measure, and
> nothing here says what it will show.

**Most of what passes is not harmless, and the check is not the protection.** A
straddle the check lets through keeps its Gray words and shifts its phase, and at
s = 0.06 that moves the worst seam point 6.8 times as far as re-shooting
the position would. What protects a capture is the start: the aimed start touches
no capture at a perfect timer. It depends on the emitter running less than about
3.50 to 3.70 ms late per step, and the only figures for that lateness are headless
ones: 7.5 ms per step at design time, and about 9.3 ms armed with the tick on. So
the next measurement is the emitter's lateness on a display machine (P0), and the
mechanism to remove is `advance()` re-arming its timer after the paint instead of
scheduling each step from Play.

**EXPERIMENT-9's “more than one capture in three … and cannot tell” becomes: of 728
touched, 627 told and 98 not** — by a reader the page does not have yet, and 295 of
the 627 told the wrong thing.

Pre-registered predictions this run falsifies, each a finding rather than a fault:
**P2c, P3, P5a, P9**. Not evaluated: **none**. Harness identities that fail: **none**;
not established: **none**.
