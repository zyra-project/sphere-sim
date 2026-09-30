# Experiment 10 — what a photograph taken across a pattern change costs a calibration

**Status: measured on the bench, with the page's own reader. This is the fourth full
run, made because the page's reader was replaced after the third.** The third run's
reader refused every clean camera position before its complement check ran, so
every loud and silent count in it was a counterfactual reader's, and its column for
the page's own reader never ran (P6). The reader that replaced it places those
positions, so this run also hands every straddled camera position to the page's own
reader — the page column, measured here for the first time, against bets registered
before any of its output existed (the next section). **Everything the old reader did
not touch reproduced byte for byte.** Every stage's checkpoint equals the third
run's once the page's own fields and each file's provenance are set aside, all 613
distinct solves are identical but for their schema and fingerprint, and against the
third run's committed results file (754147f) this one differs in 103 places of 47
kinds, each on a list of what the re-run adds or rewords, written before the
comparison: every other field is as 754147f wrote it. So every counterfactual table
below is the third run's. The reader the page replaced is kept beside the new one in
Q0, and reproduces 754147f's Q0 field for field at all 108 clean positions
(I-replaced, held outside the file by `node tools/experiment10-replaced.ts`).

The runs before this one are how the counterfactual figures were earned.
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
changed, and no counterfactual figure moved. **This document reports the last
run**: its tables are generated from the results file, and its prose quotes the
same cells.

- **Data** — [`experiments/experiment-10.json`](../experiments/experiment-10.json)
  (`sphere-sim/experiment-10@1`). Every table below is generated from it and checked
  by `npm run check:docs`. The sentence in `verdict.statement` is assembled from its
  cells, and where it quotes a figure the prose below quotes the same one.
- **Reproduce** — `npm run experiment10` runs the stages in order (`q0`, `bank`,
  `gate`, `decode`, `pose`, `rescore`, `lateness`) and then writes the file,
  resuming from the checkpoints in `experiments/.experiment-10-partial/`. With the
  page column reading every straddled position, the stages add up to about 8 h in
  one process. `--stage <name>` runs or resumes one stage, so once `q0` and `bank`
  are on disk the other five can run side by side — `pose`, `rescore` and `lateness`
  share a solve file, so start those three together — and `--stage assemble` writes
  the file from finished checkpoints alone. This run went as four lanes on 4 CPUs:
  `q0` and `bank` side by side, then `rescore`, `lateness`, `gate`, and `pose`
  followed by `decode`. At about 04:00 UTC a container restart stopped the two lanes
  still running, `rescore` and `lateness`; the other two had finished. Relaunched at
  04:28 with the same command, every stage resumed from its checkpoints, the
  finished ones at once, and each stopped lane redid at most the one unit it had in
  flight. From start to the written file took 4 h 10 min, 28 min of it stopped; the
  times here are from the run's own lane logs, which are not committed. `rescore`,
  the longest lane, computed for about 3 h 36 min, `lateness` 2 h 29 min, `pose` 65
  min, `gate` 42 min, `decode` 17 min, and `q0` and `bank` 5 to 6 min each.
  `--quick` and `--smoke` check the plumbing and never write the committed file.
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

## How the registered bets came out

Each bet above as the results file evaluates it (`predictions`), with the figures
it rests on. The harness checks come first, since the bets are read only if they
hold, and they do:

- the page's reading of the clean twin equals `experiments/reader-acceptance.json`
  at all 108 positions (I-page-twin);
- the replaced reader reproduces 754147f's Q0 at all 108 positions, in the runs it
  placed, its problems and their reasons, its description, the total, and the
  classify margin, wrong kinds and per-run figures (I-replaced). The document keeps
  only that reader's figures, so this one is held outside the file, against
  `git show 754147f:experiments/experiment-10.json`, by
  `node tools/experiment10-replaced.ts`, which finds every one of those fields
  equal at all 108 positions and prints “I-replaced HOLDS”;
- the page reads the fast path's straddled frames as it reads the renderer's in all
  8 of the gate stage's hook readings, and there the placed runs' starts, their
  content misfiles and the problem texts agree too, 8 of 8 (H8-page).

Then the bets:

- **P10 is falsified.** The page's placed runs file 238 photographs, in 162
  positions, under a step other than the one holding more than half their exposure,
  and hold 0 photographs without a majority step. Every one of the 238 falsifies
  P10, whatever its share. 225 of them are near-ties, a word this report uses for a
  share under 0.6 and not part of the bet (the terms). 216 of those come with the
  emitter running 7.5 ms late per step, 109 in L-aimed-7.5 and 107 in L-uniform-7.5:
  their majority shares run from 0.500 to 0.585, and each is filed one step after its
  majority step, on one of a run's last four frames. R3 has one more, at 0.520. R4's
  21, in 20 positions, are not all near-ties: with a hand-pressed remote, 13 of them
  hold 0.6 or more of their exposure in a step other than the one they are filed
  under, 3 of them 0.9 or more and one all of it, so the page placed runs holding a
  photograph of another step; the other 8 are near-ties, at 0.509 to 0.575, like the
  late emitter's. The page column's section says where they fall, and each cell's
  `page.misfiles.list` lists them one by one.
- **P11 is falsified, by one.** In R1 the page is SILENT on 99 of the 728 touched
  captures, against the counterfactual reader's 98. No R1 capture is QUIET, so the
  looser reading, which would count a quiet capture as kept, gives 99 as well.
- **P12 is falsified.** A straddle turns 59 runs the page's clean reading places into
  notes, each in a capture of its own: 31 in R6, with the room spill on, 13 in
  L-uniform-2, 10 in L-uniform-7.5, 3 in L-aimed-7.5 and 2 in R3.
- **P13 holds.** Q0 and the page's reading of the clean twin agree at all 108 clean
  positions: placed, out of view and barely seen alike, and neither with a problem.
- **P6 is falsified by construction**, as its note says: the page's reader places a
  run in 108 of the 108 clean positions. The reader it replaced placed none: 105
  were refused at classify, with a margin of at most 0.148, and 3 at the run count.

---

## Why it exists

`docs/EXPERIMENT-9.md` counted how often the shutter is open while the emitter
changes pattern — 728 of 2000 captures at the page's defaults, in the replay this
document scores — and said in as many words that it could not say what one costs:
*"Nothing in this experiment renders a frame or decodes one."* This experiment
renders them, through the bench's own renderer, and hands them to the page's own
code: to its reader, first on clean positions (the first section after the terms)
and then on every straddled one (the page column); and to its complement check and
decoder, told what kind each photograph is (the counterfactual reader), which is
how the first three runs measured the check and the decoder at all, since the reader
the page had then stopped every clean position short of the check. It asks three
things of each straddle, and asks each rather than assuming the answer: does the
photograph decode correctly anyway; is the run refused loudly, and at what smear;
or does it pass and decode wrong, silently, and by how much.

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
  since the reader the page had when this was designed could not tell it. The
  *content* footing (primary) observes a photograph as the kind of the part holding
  more than half its exposure; the *filed* footing, as the kind of the step it is
  filed under. Both hand the reader exact lit fractions. *They lean toward the
  reader in what it can recover, and in
  no known direction in how often it fails:* exact classification is what that
  reader lacked, so both are an ideal-classification baseline in EXPERIMENT-8's sense.
  A working classify could place no more than they let the reader place, but a
  misread reference could add a refusal or hide one, so the loud and silent counts
  below are not bounds in either direction.
- **Attributable.** A refused run counts against the straddle only if its *twin* —
  the same capture without the straddle, on the same noise — places it. *It leans
  toward calling a refusal the straddle's own.* The reader refuses runs on the
  clean capture too, mostly projectors the camera cannot see, and says “Re-shoot
  projector N” there as well; so *loud* means loud against a twin the operator never
  sees. The page column attributes the same way, against the page's own reading of
  the clean twin (the *page twin*), which notes a projector the camera cannot see
  instead of refusing it.
- **Loud and silent.** A capture is LOUD when the reader refuses a touched
  attributable run in any of its positions, which is then REFUSED-ALL (every such
  run refused) or MIXED (some refused, some placed). It is SILENT when nothing is
  refused and at least one position is PLACED, every such run placed.
  INVISIBLE-ONLY captures touch only runs the twin refuses anyway, and UNCHANGED
  ones were flagged by EXPERIMENT-9's count but changed no photograph. *LOUD leans
  toward reassurance:* a loud capture can still carry a position that passed
  silently (LOUD+SILENT), and it is counted once, as loud.
- **Quiet drop, and QUIET (the page column only).** A touched run the page twin
  places that the straddled position only notes, out of view or barely seen, with
  no problem naming it, is a *quiet drop* (P12): neither refused nor placed. A
  position holding one, with nothing refused, is QUIET, not PLACED; with nothing
  refused, a capture with a PLACED position is SILENT, and one with only a QUIET
  position is QUIET, its dropped run noted and not decoded. The counterfactual
  reader has no such class, since it refuses every run it does not place. *It leans
  toward reassurance:* a note asks the operator for nothing. The quiet drop is P12's,
  as registered. The QUIET position and capture, and LOUD+QUIET, a LOUD capture with
  a QUIET position, are not: they were defined after the bets were registered, once
  both quick runs had been read and while this run was measuring. They are
  reporting classes beside the registered SILENT, which needs a PLACED position, and
  they change no bet: R1 has no QUIET capture, and P11 is read on the registered
  SILENT.
- **Misfile (the page column only).** A photograph a run the page places files under
  another step than the one holding more than half its exposure (P10); its *share* is
  that step's. A photograph with no such step is counted apart, as ambiguous. *It
  leans toward counting a near-tie as an error:* a share just over a half is a
  photograph either filing leaves nearly half wrong, so the share is quoted with every
  count. The lean is the measure's and not the bet's: P10 counts every misfile, and
  each one falsifies it whatever its share.
- **Near-tie, and the other shares misfiles are counted at (the page column only).**
  A misfile whose share is under 0.6 is a *near-tie*: filed under either step, two
  fifths or more of it shows the other. 0.6 is a reporting cut, and so are the 0.55
  and 0.9 the counts below are also split at: each was chosen after misfiles had been
  read, 0.55 after the quick runs and 0.6 and 0.9 after this run, and none is a bet
  or part of one. The results file carries the near-tie cut beside P10's count
  (`predictions[P10].measured.nearTie`), and each cell's shares in bins a twentieth
  wide (`page.misfiles.histogram`).
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
  position** under the same seeds and keeping every other camera — the card's
  remedy for a straddle. *It leans less far toward harmless than τ_null*,
  being the smaller null, but it still assumes the re-shoot is clean, and a fresh
  start can straddle again.

A straddle's median D_grid is set against each null's **median**, with the 95th
percentile quoted beside it and never in its place. The first full run set a
median against a 95th percentile.

## The page's reader places every clean position; the one it replaced placed none

**On the bench's photographs of the 108 clean camera positions rendered from the
card's camera marks, the page's reader places a run in every one and raises no
problem; the reader it replaced placed none.** Both read the same photographs, in
Q0: each clean position rendered with noise, encoded to 8-bit sRGB and summarised
as the page reads them. The page's reader places 327 of the 432 runs and notes the
other 105 instead of refusing them: 87 out of view and 18 barely seen.

The reader it replaced refused 105 positions at classify, with a margin of at most
0.148 against the 0.15 classify needs, and 3 at the run count. The reason is
structural (found when this experiment was designed): `litFractions` normalises
across the whole capture, where one projector's white lights little of a
photograph and another's lights most of it, and within a run the coarse Gray planes
light all of the visible crescent or none of it rather than about half. So classify
cannot tell the references from the patterns, and a position that clears its
margin anyway still gets photographs the wrong kind, finds the wrong number of runs
and is refused at the run count. Classifying each run alone does not rescue it: 0
of the 288 runs of the sweep would pass, and a run classified alone still gets a
median 8 of its frames the wrong kind. The page's reader finds each run by its own
white, black and phase frames instead, and never classifies the capture.

The page column attributes against each camera's clean twin, read by the page from
the fast path's photographs: the 96 twins of the sweep and of the room spill. The
page's reading of every twin, the finer preset's 12 included, is Q0's at all 108
positions (P13) and the acceptance sweep's (I-page-twin;
`experiments/reader-acceptance.json`, whose table is in
[`docs/OPERATOR-PATH.md`](OPERATOR-PATH.md), Phase 2). On the sweep's 72 twins it
places 212 of the 288 runs and refuses none, noting 68 out of view and 8 barely
seen.

The counterfactual reader is the one the first three runs measured: the page's own
complement check, `indexByFingerprint`, handed the lit fractions a perfect classify
would give. It is not a fix anybody has specified. On the same clean positions it
refuses 66 of the 288 runs of the sweep anyway, 64 of them runs whose projector the
camera cannot see, and it would tell the operator “Re-shoot projector N” on 66 of
the 72 positions. Every run the page twin places, the counterfactual's twin places
too, and the counterfactual places 22 more across the three kinds of position: runs
the page notes out of view or barely seen and does not decode.

The page's worth report printed “Only 1 camera contributed.” for a folder read
alone, whatever the folder held, while the page read one camera position at a time.
It now covers every camera position read since the plan file was loaded, so the
line means that only one has been read.

The card's own folder shapes cost the counterfactual reader something without any
straddle (the last table). Photographs before the first white frame cost a problem
line and nothing else; a dark photograph after the last step lengthens the last run
until it is refused; and a re-shot run, appended to the position or handed in alone,
gets the whole folder refused, 192 of 192 such folders. That last one matters below,
because it is the remedy the counterfactual's refusal asks for. The page's reader
reads these shapes as their position instead. On the designed rigs, with the room
spill off and on, it reads 432 of 432 with none, one or three photographs taken
before Play and none, one or two dark ones after the last step; and every run a
position places, re-shot and added after the position (150 of 150) or played on to
the end as the page's own remedy leaves it (150 of 150). A re-shot run handed in
alone is still refused, now with how to hand it in (150 of 150;
`experiments/reader-acceptance.json`). The card says to keep every photograph and to
re-shoot a spoiled projector into the position's own folder before the tripod moves
— and still to re-shoot the whole position after a straddle, for the straddle's sake
(`docs/CALIBRATE.md`).

<!-- generated: experiment-10-precondition -->
| clean positions | raster | positions | the page’s reader: positions placed | runs placed | noted out of view · barely seen | problems | the reader it replaced: positions placed | refused at | its classify margin (needs 0.15): median · max | runs a per-run classify would rescue |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| the sweep | 320×240 | 72 | 72 | 212 of 288 | 68 · 8 | 0 | 0 | classify 70 · run count 2 | 0.048 · 0.201 | 0 of 288 |
| room spill on | 320×240 | 24 | 24 | 80 of 96 | 7 · 9 | 0 | 0 | classify 23 · run count 1 | 0.052 · 0.201 | 0 of 96 |
| the finer preset | 640×480 | 12 | 12 | 35 of 48 | 12 · 1 | 0 | 0 | classify 12 | 0.047 · 0.147 | 0 of 48 |
| **all** | | **108** | **108** | **327 of 432** | **87 · 18** | **0** | **0** | **105 at classify** (margin at most 0.148), 3 at the run count, having cleared classify (margin 0.172–0.201) and found 2 of 4 runs, 0 elsewhere | | |

_Both readers read the same photographs: each clean position rendered with noise, encoded to 8-bit sRGB and summarised as the page reads them. The reader the page replaced classified the whole position into white, black and patterned before it counted runs; the page’s reader finds each run by its own white and black, and notes a projector this camera cannot see instead of refusing it._

_What the page’s worth report printed for one clean folder read alone, as it did while it read a camera position at a time: “Only 1 camera contributed.”_

| the counterfactual reader, clean | runs | placed | refused anyway | of those, invisible | minor | marginal | positions told “Re-shoot projector N” | clean noise floor: median · max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| the sweep | 288 | 222 | 66 | 64 | 19 | 3 | 66 of 72 | 0.0060 · 0.1386 |
| room spill on | 96 | 89 | 7 | 6 | 20 | 0 | 7 of 24 | 0.0067 · 0.0879 |
| the finer preset | 48 | 38 | 10 | 10 | 3 | 0 | 10 of 12 | 0.0031 · 0.0568 |

| the page’s reader, clean (the page twin) | runs | placed | noted out of view | barely seen | refused | problems | crashed | placed by both readers · the counterfactual alone · the page alone |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| the sweep | 288 | 212 | 68 | 8 | 0 | 0 | 0 of 72 | 212 · 10 · 0 |
| room spill on | 96 | 80 | 7 | 9 | 0 | 0 | 0 of 24 | 80 · 9 · 0 |
| the finer preset | 48 | 35 | 12 | 1 | 0 | 0 | 0 of 12 | 35 · 3 · 0 |

| folder shapes an operator can produce, read by the counterfactual reader | positions | runs placed (the plain folder’s) | refused whole | its reasons |
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

_Q0b is the counterfactual reader’s: the complement check handed each shape’s exact frame kinds. The page’s reader was held to the same shapes by the acceptance sweep (`experiments/reader-acceptance.json`), not here._
<!-- /generated -->

## What a straddle costs, read by the counterfactual reader

**Given bookends that can place runs, most touched captures are refused loudly, and
most of what passes silently moves the seams further than re-shooting would.** The
reader here is the counterfactual, the complement check told every photograph's
kind; the next section reads the same captures through the page's own reader. This
is R1, EXPERIMENT-9's headline cell
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

## The same captures through the page's own reader

**Through the page's own reader a straddle is about as loud as through the
counterfactual, and silent about as often: of R1's 728 touched captures it refuses
626 loudly and passes 99 silently, one more than the counterfactual's 98, which
falsifies P11.**
This is the page column. Every changed position of every rig was read whole by the
page's reader, from the fast path's noisy frames encoded to 8-bit sRGB as the page
reads them, and each run is attributed against the page's reading of the same clean
frames. It read every rig of every cell and crashed on no position; R8 and
L-aimed-2 touch no capture, so there it had nothing to read. In every cell its LOUD
and SILENT counts are each within 15 captures of the counterfactual's.

<!-- generated: experiment-10-page -->
| cell | captures touched | LOUD (share, 95% CI) | LOUD+SILENT | LOUD+QUIET | SILENT | QUIET | INVISIBLE-ONLY | UNCHANGED | quiet drops: runs (captures) | misfiled photographs (the largest majority share) | crashes |
| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | ---: |
| R1 | 728 of 2000 | 626 (86.0%, 83.4–88.4%) | 34 | 0 | 99: 28 harmless, 14 biased, 27 gate-breaking, 30 not solved | 0 | 3 | 0 | 0 (0) | 0 | 0 |
| R2 | 675 of 2000 | 610 (90.4%, 88.0–92.6%) | 12 | 0 | 63 (not solved) | 0 | 2 | 0 | 0 (0) | 0 | 0 |
| R3 | 163 of 2000 | 125 (76.7%, 69.6–83.3%) | 1 | 0 | 23 (not solved) | 0 | 15 | 0 | 2 (2) | 1 (0.520) | 0 |
| R4 | 495 of 500 | 483 (97.6%, 96.1–98.8%) | 100 | 0 | 9 (not solved) | 0 | 3 | 0 | 0 (0) | 21 (1.000) | 0 |
| R5 | 801 of 2000 | 644 (80.4%, 78.2–82.8%) | 50 | 0 | 148 (not solved) | 0 | 9 | 0 | 0 (0) | 0 | 0 |
| R6 | 728 of 2000 | 631 (86.7%, 84.1–89.1%) | 30 | 3 | 93 (not solved) | 1 | 3 | 0 | 31 (31) | 0 | 0 |
| R7 | 760 of 2000 | 622 (81.8%, 79.0–84.7%) | 40 | 0 | 123 (not solved) | 0 | 10 | 5 | 0 (0) | 0 | 0 |
| R8 | 0 of 2000 (nothing to read) | 0 | 0 | 0 | 0 (not solved) | 0 | 0 | 0 | 0 (0) | 0 | 0 |
| L-aimed-2 | 0 of 2000 (nothing to read) | 0 | 0 | 0 | 0 (not solved) | 0 | 0 | 0 | 0 (0) | 0 | 0 |
| L-uniform-2 | 1249 of 2000 | 927 (74.2%, 72.0–76.4%) | 105 | 0 | 225 (not solved) | 0 | 70 | 27 | 13 (13) | 0 | 0 |
| L-aimed-7.5 | 1786 of 2000 | 1352 (75.7%, 73.6–77.8%) | 356 | 0 | 330: 4 harmless, 1 biased, 13 gate-breaking, 312 not solved | 0 | 104 | 0 | 3 (3) | 109 (0.585) | 0 |
| L-uniform-7.5 | 1893 of 2000 | 1704 (90.0%, 88.6–91.4%) | 312 | 0 | 105 (not solved) | 0 | 75 | 9 | 10 (10) | 107 (0.584) | 0 |

_Policy P, through the page’s own reader, on the fast path’s noisy frames encoded as the page reads them. Each run counts against the straddle only where the page’s reading of the same clean frames places it. A quiet drop is a touched run that reading places and the straddled one only notes out of view or barely seen, with no problem naming it; a position holding one with nothing refused is QUIET, not PLACED. With nothing refused, a capture is SILENT when some position is PLACED, and QUIET when none is and some position is QUIET: its dropped run is noted, not decoded, and no harm is read for it. The counterfactual reader has no QUIET class, since it refuses every run it does not place. LOUD+QUIET is a LOUD capture with a QUIET position (LOUD with a quiet drop), counted apart from LOUD+SILENT, which needs a PLACED position; a quiet drop inside a refused position makes no position QUIET and is counted only among the quiet drops. A SILENT capture is judged only by a counterfactual solve of the page’s own plan, placement included; the rest are not solved. A misfiled photograph is one a placed run files under another step than the one holding more than half its exposure, and its share is that step’s. A crash is a folder the reader threw on, counted as refused._
<!-- /generated -->

**Run by run the two readers mostly agree, and where they part in R1 the page places
runs the counterfactual's bookends refuse.** R1 has 2374 touched runs both clean
twins place, so either reader can hold the straddle to account for them (the first
of the page's run tables, in the section on what the page tells the operator).
Both readers place 371 of them and both refuse 1810. The page places 166 that the
counterfactual refuses, every one by its bookends' count, and files every
photograph of them by what it shows, since R1 has no misfile; it refuses 27 that
the counterfactual places. By capture, it passes 11 of the counterfactual's 627
loud captures silently and refuses 10 of its 98 silent ones loudly. Another 112
touched runs are placed by the counterfactual's twin alone, and the page refuses
(63) or notes (49) them without either counting against the straddle; the page
twin alone places none.

**What the page lets through is judged only where a solve has its plan.** The page
column decodes nothing, so a SILENT capture takes a counterfactual solve's harm
only where the page's plan, placement included, is that solve's. In R1 that holds
for 69 of the 99: 28 are harmless, 14 biased, and 27 break the 1 mm seam gate. The
other 30 were never solved on the page's own plan, and are not judged. With the
emitter 7.5 ms late per step, 18 of L-aimed-7.5's 330 are judged the same way: 4
harmless, 1 biased and 13 past the gate, 2 of those 13 with a run holding one of
P10's misfiled photographs in their solve (below). No other cell was solved.

**What it tells the operator is in its own section below, beside the
counterfactual's words.** In every cell, most of the runs it refuses are told that
no run could be found, in the folder or for that projector; none is told that a
straddle happened; and a quiet drop gets a note that there is nothing to gain by
re-shooting it (P12, below).

**P10: every misfile falsifies it. Under a late emitter the page's misfiles are all
near-ties; under a hand-pressed remote 13 of its 21 are not.** The page's placed
runs file 238 photographs, in 162 positions of four cells, under a step other than
the one holding more than half their exposure. 216 of them are in the two cells
where the emitter runs 7.5 ms late per step, 109 in L-aimed-7.5 and 107 in
L-uniform-7.5, in runs the page placed as the folder orders them. Each is filed one
step after its majority step, on one of a run's last four frames, and their majority
shares run from 0.500 to 0.585, 98 and 95 of them under 0.55. A late emitter moves
each photograph a little further into the step before, and these are photographs
where that step had just passed half the exposure: either filing leaves two fifths
or more of such a photograph showing the other step.

R4's 21, in 20 positions, are not all near-ties. With a hand-pressed remote, the
page files 11 photographs one step after their majority step and 10 one step
before, on Gray frames 2, 3, 4, 7 and 8 and phase frames 26 to 32, again in runs
placed as the folder orders them, and their majority shares run from 0.509 to
1.000: 13 hold 0.6 or more of their exposure in a step the page did not file them
under, 3 of them 0.9 or more and one all of it; the other 8 are near-ties, at 0.509
to 0.575, like the late emitter's. Numbering trials and photographs from 0, those 3
are photograph 97 of trial 264's first position (0.998), photograph 36 of trial
408's first (0.901) and photograph 4 of trial 493's third (1.000). So the page
placed runs holding a photograph of another step, which its reader was built never
to do. R3, at a 1/60 s exposure, has one more, a near-tie at 0.520 filed one step
before its majority.

**The page column decodes none of these runs, but the counterfactual's decodes read
25 of them as the page files them, and its solves 3 more.** The counterfactual
places R3's run and 15 of R4's 20, 58 of L-aimed-7.5's 72 and 36 of L-uniform-7.5's
69, each filed exactly as the page files it, misfiled photographs included
(`page.misfiles.counterfactual`). Its decode subsample, which reads each run it
draws through the page's own `readRun` on 8-bit sRGB, drew 25 of those 110 runs,
holding 31 misfiled photographs: R3's, 8 of R4's holding 9, 13 of L-aimed-7.5's
holding 17 and 3 of L-uniform-7.5's holding 4. Their decodes are listed there, each
with the extremes of its cell's decode subsample that it alone sets. In R4, the run
of trial 264's first position holding photographs 95 and 97 (0.759 and 0.998) has
the cell's largest mean shift along *u*, 6.9361 px, with 16 of its 113 matched
pixels grossly wrong; the run of trial 493's third holding photograph 4 (1.000) has
the cell's largest loss, 2293 correspondences fewer than its twin's, and none of its
13801 matched pixels moved. The other 6 of R4's move their means by at most 1.6472
px. R3's run has that cell's most negative mean shift along *v*, −1.3545 px. Under
the late emitter, the 16 runs drawn shift their means 3.6 to 4.6 px along *u* and
3.1 to 3.8 px along *v*, each past its cell's 90th percentile on both axes, and in
each cell one of them has the subsample's largest shift along both axes and its
largest loss. A run is decoded whole, so none of this separates what a misfiled
photograph does from what the rest of its straddle does. The other 137 runs holding
a misfile are in no decode subsample: the 52 only the page places, which the
counterfactual's bookends refuse (R4's other 5, by count or by kind, and 14 of
L-aimed-7.5's and 33 of L-uniform-7.5's, by length), and 85 its subsample did not
draw. Three of those 85, holding 4 photographs at 0.506 to 0.532, are decoded all
the same, filed as the page files them, inside the counterfactual solves that judge
their captures on the page's own plan (`page.misfiles.counterfactual.solves`): in
L-aimed-7.5's trials 57, 58 and 68, the third position's last run, holding
photograph 135, and in trial 68 photograph 134 too. Trials 58 and 68 are page-SILENT
captures past the seam gate, at D_grid 11.91 and 26.83 mm, the second the largest of
the cell's 27 solves of the page's own plan; trial 57 is LOUD+SILENT, and its silent
part is past the gate too, at 7.01 mm. A solve reports the calibration, not the run,
so these no more separate what a misfile does than a decode does. No other solve
decodes a run holding a misfile, and the other 134 are not decoded at all.

**P12: the page quietly drops 59 runs its clean reading places, 31 of them in R6,
with the room spill on.** In each, the straddled position notes the run out of view
(1) or barely seen (58), with no problem naming it, and its note says there is
nothing to gain by re-shooting it from there; the clean reading of the same position
places it. 55 of the 59 sit in positions the page refuses anyway. The other 4, all
in R6, make their positions QUIET, in 4 captures: 1 QUIET, and 3 LOUD with a QUIET
position. In each of those 4 the QUIET position places another touched run beside
the dropped one, which reaches the calibration straddled with no class counting it.
The results file lists every drop with how it was noted and with its clean run's
light as the acceptance sweep measured it, joined in the assembly with
`experiments/reader-acceptance.json` (`page.quiet.list`). Every one of R6's 31 is a
run lit only by the wall behind the sphere — 7 runs, lighting 35 to 226 pixels —
which the page's clean reading places and can decode only off the sphere. The other
28 are 3 runs on the sphere lighting 58 to 83 pixels, crescents of 10 to 14
fingerprint blocks, which the straddle takes below the 8 blocks the page needs to
check a run.

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
and 104 touching only runs that are refused anyway. Those are the counterfactual's;
through the page's own reader the same captures are 1352 loud and 330 silent, and
its placed runs file 109 photographs under the step after the one each mostly
shows, every one a near-tie (the page column's section). At 2 ms per step, a
design-time estimate of the page's script alone with no paint, none of the 2000 is
touched.

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

**Neither reader says that the photographs were taken while the pattern changed.
When the counterfactual refuses a run on its own it mostly blames a dropped and a
duplicated frame. The page's own reader mostly says it found no run in the folder at
all in R1, R2, R5, R6 and R7, and in the other five cells it read mostly names the
projector whose run it could not use.** Of R1's 627 loud captures, the
counterfactual refuses 332 only as whole positions — “Found N projector runs” — and
re-shooting that position is a remedy the page reads. The other 295 are refused run
by run: 295 of them are told “Re-shoot projector N”, and 295 that the photographs
look like a dropped frame and a duplicated one. That is not what happened, and the
remedy was one that reader could not read back: a folder holding a re-shot run,
appended or alone, is refused whole (192 of 192 in the first section's folder
table).

The page's own reader refuses 437 of its 626 loud captures only as whole positions,
and 189 run by run, each of those told “Re-shoot projector N” and 82 of them also
that the photographs look like a dropped and a duplicated frame, in the complement
check's own words, which the page's reader keeps. Of the 1837 touched runs it
refuses in R1 that its clean reading places, 1511 are refused by one problem about
the whole folder: “No projector run could be found in the 136 photographs”, which it
explains as what a folder from another plan, a camera that moved during the run, or
photographs not in the order they were shot look like. It could not find another
228, and refuses 98 as a broken pair (the last table). So it is in R2, R5, R6 and
R7, where 80 to 83% of such runs are told there is no run in the folder. In the
other five cells it read, most such runs are told instead which projector's run it
could not use, and to re-shoot that projector. Only these are told there is no run
in the folder: 42 of R3's 219, at a 1/60 s exposure; 1120 of R4's 2521, with a
hand-pressed remote; 442 of 1859 with the emitter 2 ms late per step (L-uniform-2);
and with it 7.5 ms late, 134 of 4057 (L-uniform-7.5) and none of 2324 at the card's
aimed start (L-aimed-7.5). It
reads a re-shot run added to the position's folder, or played on to the end, in
place of the original (the first section), so re-shooting the projector it names is
a remedy it reads. After a straddle it is still the wrong one: a straddle smears the
whole position and each run crosses the check at its own smear (the section on
crossings), so the runs that passed can carry the same smear silently, and
re-shooting only the projector named keeps them. The card says to re-shoot one
projector into the same folder for a frame spoiled on its own, before the tripod
moves, and the whole position, aimed, after a straddle (`docs/CALIBRATE.md`).

A silent position gets no message at all, from either reader, and a quiet drop gets
a note that asks for nothing (the page column's section). Under policy A, which
keeps a MIXED position's placed runs because that is what the page decodes, 97 of
R1's loud captures also carry a silent part for the counterfactual — a PLACED
position, or the placed runs of a MIXED one — against 31 under policy P, which
counts only PLACED positions.

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

The page's own run tables follow: R1 run by run against the counterfactual, every
cell summarised, each reader's LOUD captures by what they are told, and the page's
words on the runs it refuses.

<!-- generated: experiment-10-page-runs -->
| R1, touched runs both clean twins place | counterfactual: placed | refused: complement | bookends count | bookends length | bookends kind | unanswered | classify | all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| the page placed | 371 | 0 | 166 | 0 | 0 | 0 | 0 | 537 |
| the page refused | 27 | 778 | 996 | 21 | 15 | 0 | 0 | 1837 |
| the page only noted (a quiet drop) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **all** | **398** | **778** | **1162** | **21** | **15** | **0** | **0** | **2374** |

_R1's other touched runs: the counterfactual’s twin alone places 112: the page refused 63 (the counterfactual placed 0), the page noted 49 (the counterfactual placed 6); the page twin alone places 0; neither twin places 727. The counterfactual’s column is its deciding evaluation, fully noisy in R1; the page reads the same noisy frames encoded as it reads them._

| cell | touched runs both twins place | both place | both refuse | the page places, the counterfactual refuses | the page refuses, the counterfactual places | the page only notes | the counterfactual’s twin alone | the page twin alone | captures: the counterfactual’s LOUD the page passes SILENT · its SILENT the page refuses LOUD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| R1 | 2374 | 371 | 1810 | 166 | 27 | 0 | 112 | 0 | 11 · 10 |
| R2 | 2269 | 236 | 1828 | 177 | 28 | 0 | 100 | 0 | 17 · 5 |
| R3 | 348 | 56 | 216 | 71 | 3 | 2 | 16 | 0 | 6 · 0 |
| R4 | 2852 | 313 | 2473 | 18 | 48 | 0 | 130 | 0 | 0 · 2 |
| R5 | 2637 | 505 | 1856 | 252 | 24 | 0 | 119 | 0 | 21 · 11 |
| R6 | 2644 | 407 | 2007 | 176 | 23 | 31 | 323 | 0 | 7 · 6 |
| R7 | 2431 | 466 | 1824 | 120 | 21 | 0 | 116 | 0 | 8 · 3 |
| R8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 · 0 |
| L-aimed-2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 · 0 |
| L-uniform-2 | 2840 | 840 | 1835 | 128 | 24 | 13 | 118 | 0 | 1 · 16 |
| L-aimed-7.5 | 3524 | 1145 | 2308 | 52 | 16 | 3 | 130 | 0 | 6 · 0 |
| L-uniform-7.5 | 6197 | 2043 | 3962 | 87 | 95 | 10 | 299 | 0 | 0 · 11 |

_Touched runs of the changed positions the page read, on the counterfactual’s deciding evaluation. A crash counts with the page’s refusals. “Alone”: the one clean twin places the run and the other does not, so only the one reader can hold the straddle to account for it._

| cell | LOUD: the counterfactual · the page | refused only as whole positions | refused run by run | of those, told “Re-shoot projector N” | told it looks like a dropped and a duplicated frame |
| --- | --- | --- | --- | --- | --- |
| R1 | 627 · 626 | 332 · 437 | 295 · 189 | 295 · 189 | 295 · 82 |
| R2 | 622 · 610 | 307 · 436 | 315 · 174 | 315 · 174 | 315 · 95 |
| R3 | 131 · 125 | 54 · 13 | 77 · 112 | 77 · 112 | 66 · 36 |
| R4 | 482 · 483 | 131 · 84 | 351 · 399 | 351 · 399 | 351 · 380 |
| R5 | 654 · 644 | 366 · 446 | 288 · 198 | 288 · 198 | 288 · 74 |
| R6 | 633 · 631 | 333 · 429 | 300 · 202 | 300 · 202 | 300 · 82 |
| R7 | 627 · 622 | 317 · 424 | 310 · 198 | 310 · 198 | 310 · 112 |
| R8 | 0 · 0 | 0 · 0 | 0 · 0 | 0 · 0 | 0 · 0 |
| L-aimed-2 | 0 · 0 | 0 · 0 | 0 · 0 | 0 · 0 | 0 · 0 |
| L-uniform-2 | 912 · 927 | 275 · 102 | 637 · 825 | 637 · 825 | 556 · 124 |
| L-aimed-7.5 | 1358 · 1352 | 0 · 0 | 1358 · 1352 | 1358 · 1352 | 806 · 100 |
| L-uniform-7.5 | 1693 · 1704 | 56 · 14 | 1637 · 1690 | 1637 · 1690 | 880 · 128 |

| the page’s refused runs | refused | broken pair | run not found | run not found, a room’s light | a photograph too many after the run | a run’s count between found neighbours | no run in the folder |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| R1 | 1837 | 98 | 228 | 0 | 0 | 0 | 1511 |
| R2 | 1856 | 110 | 210 | 0 | 0 | 0 | 1536 |
| R3 | 219 | 36 | 138 | 0 | 0 | 3 | 42 |
| R4 | 2521 | 823 | 576 | 0 | 2 | 0 | 1120 |
| R5 | 1880 | 88 | 255 | 0 | 0 | 0 | 1537 |
| R6 | 2030 | 103 | 272 | 3 | 0 | 0 | 1652 |
| R7 | 1845 | 138 | 226 | 0 | 0 | 0 | 1481 |
| R8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| L-aimed-2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| L-uniform-2 | 1859 | 126 | 1291 | 0 | 0 | 0 | 442 |
| L-aimed-7.5 | 2324 | 102 | 2095 | 0 | 127 | 0 | 0 |
| L-uniform-7.5 | 4057 | 130 | 3476 | 0 | 101 | 216 | 134 |

_The page’s words on each touched run it refuses and its clean reading places: the problems naming the run, or where none does, those about the whole folder, each class counted once per run. A run can be told more than one thing, so a row can sum past its refusals._
<!-- /generated -->

## What this does not measure

- **A real sphere.** Everything is bench photometry: flat albedo, constant ambient,
  Gaussian shot noise, point-sampled patterns, a single grey channel, no defocus and
  no JPEG. The classify margins, the clean residual floors and the invisible-run
  refusals are bench numbers.
- **The page's decode, and the harm only its own plan could show.** A working page
  is measured now, on the bench: every straddled position went through the page's
  own reader (the page column). But the column reads which runs the page places and
  where, and decodes none of them, so what a straddle does to the coordinates of a
  run only the page places is not measured: the runs it places where the
  counterfactual refuses them, all by its bookends but one each in R2 and
  L-uniform-2 refused at its complement check. Among those are 52 of the 162 runs
  holding P10's misfiles, 5 of them R4's. The counterfactual places the other 110,
  filed as the page files them, and its decode subsamples drew 25 of those, 8 of
  them R4's; the other 85 are in no decode subsample, and only 3 of them,
  L-aimed-7.5's, are decoded at all, inside the solves that judge their captures on
  the page's own plan (the page column's section). And a page-SILENT capture whose
  plan no counterfactual solve has is not judged: 30 of R1's 99, 312 of
  L-aimed-7.5's 330, and every one in the other cells, where nothing was solved. Nor
  is a LOUD+SILENT capture's placed part without such a solve: 13 of R1's 34, 347 of
  L-aimed-7.5's 356, and every one in the other cells.
- **The display machine's timing.** The emitter's lateness was never measured here:
  the emitter-timing probe its design called for (`tools/emitter-timing.ts`) was never built, so 7.5 ms is a
  design-time headless figure and every lateness in this document is an input, not a
  result. No sentence about the aimed start stands without the lateness beside it.
- **The camera side.** A folder is exactly its 136 photographs (the card's own extra
  end photographs are measured apart: for the counterfactual reader in the first
  section's folder table, and for the page's by the acceptance sweep);
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

**First, the reader: the page's own reader now places every clean bench position,
and what it does with a straddle is measured.** The reader the page had when this
experiment was designed placed none of the 108, for two reasons: a classify that
relied on a patterned frame lighting about half the crescent, which a coarse Gray
plane does not, and a run count that expected a run from every projector, which a
camera cannot always see — of the counterfactual reader's 66 refusals on clean
positions, 64 are runs of a projector out of sight. The reader that replaced it
finds each run by what the run's own frames show and notes a projector out of
sight, and places a run in all 108 with no problem.

**Through the page's reader a straddle is mostly loud, and the words do not say what
happened.** It refuses 626 of R1's 728 touched captures and passes 99 silently, one
more than the counterfactual's 98, which falsifies P11, and in every cell its loud
and silent counts are each within 15 captures of the counterfactual's. In R1, as in
R2, R5, R6 and R7, most of its refusals say no projector run could be found in the
folder (in R1, 1511 of the 1837 runs it refuses that its clean reading places), and
the rest name a projector to re-shoot. In the other five cells it read (R3, R4,
L-uniform-2, L-aimed-7.5 and L-uniform-7.5) most name one, and with the emitter 7.5
ms late at the card's aimed start every one does (2324 of 2324). After a straddle,
re-shooting one projector is the wrong remedy. The card's is to re-shoot the whole
position, aimed; the refusal text still does not say so, which is recorded here and
not acted on. It also quietly drops 59 runs its clean reading places, 31 of them in
R6, with the room spill on, noting each with nothing to re-shoot, which falsifies
P12.

**Under a late emitter, its misfiles are near-ties.** The 216 photographs it files
under the step after the one they mostly show, at 7.5 ms per step, hold between
0.500 and 0.585 of their exposure in that step: filed either way, two fifths or more
of each shows the other step. Each is still a misfile, and falsifies P10 as any
other does.

**Under a hand-pressed remote it places runs holding a photograph of another step,
which the reader was built never to do.** 13 of R4's 21 misfiled photographs hold
0.6 or more of their exposure in a step other than the one they are filed under, 3
of them 0.9 or more and one all of it; the other 8 are near-ties, like the late
emitter's. That is a reader defect to fix. It also strengthens the card's rule to
shoot with an intervalometer and never press a remote by hand for each frame:
EXPERIMENT-9 measured a hand-pressed remote as the worst arrangement, and here the
page places some of its captures' runs with a photograph of the wrong step in them.

**Most of what passes is not harmless, and the check is not the protection.** A
straddle the check lets through keeps its Gray words and shifts its phase, and at
s = 0.06 that moves the worst seam point 6.8 times as far as re-shooting the
position would. Of the page's 99 silent captures in R1, the 69 a solve of the page's
own plan can judge are 28 harmless, 14 biased and 27 past the seam gate. What
protects a capture is the start: the aimed start touches no capture at a perfect
timer. It depends on the emitter running less than about 3.50 to 3.70 ms late per
step, and the only figures for that lateness are headless ones: 7.5 ms per step at
design time, and about 9.3 ms armed with the tick on. So the next measurement is
still the emitter's lateness on a display machine (P0), and the mechanism to remove
is `advance()` re-arming its timer after the paint instead of scheduling each step
from Play.

**EXPERIMENT-9's “more than one capture in three … and cannot tell” becomes, through
the page's own reader: of 728 touched, 626 told and 99 not** — and none of the 626
told that a straddle is what happened.

Pre-registered predictions this run falsifies, each a finding rather than a fault:
**P2c, P3, P5a, P6, P9, P10, P11, P12**. Not evaluated: **none**. Harness identities
that fail: **none**; not established: **none**. I-replaced, held outside the file by
`node tools/experiment10-replaced.ts`, holds.
