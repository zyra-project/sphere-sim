# Calibrating a sphere — field card

What to do at the sphere, in the order to do it, to capture a structured-light
calibration. Companion to `docs/VISIT.md`, which is a different errand: that card
*measures an installation to check the model*, this one *photographs an
installation to recover its geometry*.

> **Read this first: the page reads the bench's rendered captures, and has never
> read a real one.** Phases 1 to 3 of `docs/OPERATOR-PATH.md` have landed: there
> is a supported way to put the patterns on the sphere (Part 4), the emitter
> writes the plan down beside your photographs, and the same page reads a folder
> of them back — finding each projector's run by what that run's own white,
> black and phase frames show, checking every Gray plane against its own
> complement, decoding the runs it can vouch for, and reporting what the capture
> was worth. On the bench's rendered photographs — every clean camera position
> `docs/EXPERIMENT-10.md` rendered from this card's three marks, 108 of them,
> with and without the patterns spilling past the ball onto the wall behind it
> — it refuses none, and files no photograph under the wrong projector or frame.
> A projector a position cannot see at all, 80 of them there, it notes as out of
> view instead of refusing; one that barely grazes the ball from where you stood
> it notes as barely seen or out of view, and does not decode from there
> (`experiments/reader-acceptance.json`).
>
> **Until 2026-09-29 it refused every one of those positions**, before it decoded
> a single photograph. It sorted the whole folder into white, black and patterned
> frames by how much of each was lit, and a sphere breaks that: from any one
> position some projectors are out of sight, and the coarse Gray planes light all
> of a visible crescent or none of it. Nothing had caught it because nothing had
> handed the page a rendered capture. Earlier versions of this card said no code
> here read a folder, which stopped being true; a later one said the folder could
> be read, which on a realistic capture was not true either; the one before this
> said the page refused every realistic capture, which on the bench's is no
> longer true. All three are the drift Part 7 exists to prevent.
>
> **So a capture made today is worth reading back, and it is still evidence, not
> a calibration.** Nothing here has read a real photograph, and nobody has yet
> handed the page a straddled capture (Part 4).
>
> **What still cannot happen is a pose.** The reader stops at *what the capture
> was worth* — how many correspondences survived, from how many camera and
> projector pairs, which cameras contributed nothing — and does not go on to a
> projector position. That needs the intrinsics and rough poses Part 1 and
> Part 2 tell you to bring, and the reader does not yet take them. Phase 4 —
> the before-and-after, and a one-step way to undo an install — is not built
> either.
>
> **And none of it has met a real room.** Every photograph this chain has ever
> read was synthesised, the bench's renders the most realistic of them: flat
> albedo, constant ambient, modelled sensor noise, one grey channel, no JPEG,
> nobody walking through. So the most valuable thing a capture made today
> produces is not a calibration. It is the first evidence about whether any of
> this survives a real sphere — and that is worth more than the calibration,
> because every number on this card is currently a prediction.

---

## The day, in one page

**Everything after this section is *why*. This is *what*.** Each line names the
Part that argues for it, so a rule you doubt can be checked rather than obeyed.

**Before anything else: the page reads the bench's rendered captures and has
never read a real one** (the top of this card). A capture made now is evidence,
not a calibration.

### Before you leave the desk

- [ ] **Calibrate the camera.** Write down `fx`, `fy`, `cx`, `cy`, `k1`, `k2`,
      `p1`, `p2`, at **the zoom and focus you will shoot with**. The solver takes
      these as an input. Arrive without them and there is nothing to hand it.
      (Part 1.1)

### Setting up — the projectors

- [ ] **Projectors on. Start a 20-minute timer** and do everything else while
      they warm. This is a precondition, not advice (`AMENDMENTS.md` A-23).
- [ ] **Darken the room.**
- [ ] Open `/emit/` on the display machine **over `http://`** — a copied folder
      opened by double-clicking will not run — and put it **full-screen on the
      framebuffer that drives the projectors**. That window *is* the projectors:
      SOS drives all of them as quadrants of one screen. (Part 4)
- [ ] Enter the projector count and one projector's raster. **Confirm the page
      says each quadrant came out exactly one raster.** If it did not, display
      scaling is resampling every pattern on its way out. Fix it before shooting.
- [ ] **Step to each projector's white frame and confirm the projector that
      lights up is the one the page names.** A quadrant order that differs from
      the config's gives you a confidently wrong calibration, not a failed one.
- [ ] Set **auto-advance to 2 seconds or more** and tick **"Tick on each step"**.
      (Part 4, *Starting the run*)
- [ ] **Save the plan.** `capture-plan.json` travels with the photographs and the
      reader refuses a folder without it.

### Setting up — the three positions

- [ ] Tape three marks roughly **120° apart**, about **1.5 m** off the floor,
      far enough back for the whole silhouette with some room behind. Not lined
      up with a projector or a seam. (Part 2)
- [ ] **Label each mark with which side of the sphere it is** — "north, by the
      door" is enough. That label is a solver input. You do **not** need to
      measure the distance; it is recovered from the photographs.

### Setting up — the camera, once

- [ ] **Tripod.** Not a monopod, not your hands: 4.61 mm against 380–410 mm, and
      handheld does not improve with a better camera. (Part 3)
- [ ] **Full manual, nothing adaptive.** Exposure, focus, white balance, ISO by
      hand; HDR, scene modes, per-frame noise reduction and content-dependent
      lens correction all off. Each of these destroys a capture *silently*.
- [ ] **Set exposure on the all-white frame** so nothing clips inside the lit
      crescent. The black frame will then look nearly black. That is correct.
- [ ] **Shoot JPEG**, and if you shoot raw as well, develop it to **sRGB**. The
      page reads every file as sRGB whatever it held, so a raw developed to a
      linear or wide-gamut file is silently misread. (Part 3.6)
- [ ] **Intervalometer at the same interval as the dwell.** Not a hand-pressed
      remote, which is the worst arrangement measured.

### Each position, three times

- [ ] **Arm** the page. The panel and the cursor disappear — everything drawn is
      light on the ball, the controls included.
- [ ] **Start the intervalometer first and let it run.** Then **press Play about
      half a dwell after you hear a shot** — one second after a shot, at a
      2-second dwell. You are aiming the next shutter at the middle of the white
      frame. This one line is the cheapest thing on this card. Without it,
      and with a perfect timer, **one capture in three has photographs taken
      mid-change** — usually a whole camera position of them; with the page
      7.5 ms late per step, as in a headless browser, most do, and the straddle
      sweeps across a position instead of covering it whole (Part 4). Read by a
      reader that places every run — EXPERIMENT-10's, since nobody has yet
      handed the page's own a straddled capture — most of those are
      refused at your desk, which is a return trip, and most of what passes is
      not harmless: a small smear moves the seams several times as far as a
      re-shoot does. With it, none of 2000 simulated captures did — but only
      while the page runs less than about 3.50 to 3.70 ms late per step, and
      the only figures for that lateness, from a headless browser, are 7.5 and
      about 9.3 ms. **So aim: it is necessary, not yet sufficient.**
      (Part 4, *Starting the run*)
- [ ] **Then do not touch anything.** 34 frames per projector — 136 and about
      4½ minutes on a four-projector rig at a 2-second dwell; the page shows the
      count for yours. The tone marks each step, so you can hear that the shutter
      is still falling between steps rather than on them.
- [ ] **The position is done at the page's end tone, not when the sphere goes
      dark on your side.** Each step ticks; the end is a lower, longer tone, as
      the page paints the screen black. From where you stand the sphere looks
      dark for the whole run of a projector lighting its far side — one this
      camera cannot see — and that run is still playing and must still be
      photographed: its dark photographs are how the page counts it. (Part 4.6)
- [ ] **Stop the intervalometer soon after the end tone**, then **check
      on the camera before you move** (Part 5): white frame not clipped inside
      the crescent, black frame nearly black, finest stripes clearly separated
      rather than shimmering, whole silhouette in frame.
- [ ] **Keep every photograph, and keep the extras few.** Delete nothing — not
      the dark photographs after the screen went black, not the ones before you
      pressed Play: the page sets them aside with a note. But a projector this
      camera cannot see is a run of dark photographs too, and at either end of
      the folder it looks just like extras, so keep them **under about 30 at
      each end** — about a minute at a 2-second dwell. Past that the page may
      not be able to tell which projector is which, and it refuses the folder
      rather than guess — unless photographs are missing at the other end as
      well, from a camera started after Play or stopped before the end tone
      where a projector it cannot see was playing: then it can file every run
      under the wrong projector with nothing to say so. (Part 4.6)
- [ ] **If you know a frame was spoiled** — somebody walked into the beam, a
      shot was missed — **re-shoot that projector now, into the same folder,
      before you move the tripod.** Press **Home**, then **]** until the page
      shows that projector's white, start the intervalometer and press
      **Play** as you did at the start. Let the page play on to the end, or stop
      the camera once that run is done: **stop the camera, not the page.** Leave
      the spoiled run where it is. (Part 4.2)
- [ ] Move the tripod to the next mark. Press **Home** to return the page to
      frame 0, and repeat from *Arm*.

### Before you leave the sphere

- [ ] **Three folders, one per position**, each carrying `capture-plan.json`,
      each labelled with the side of the sphere it was shot from, and numbered
      1, 2, 3 — the camera number you will give it when you read it back.
- [ ] **Filenames sort in capture order**, and when you hand them in, **select
      them from a dialog sorted by name, ascending.** The page reads them in the
      order your file picker gives it, not in an order it works out for itself.
      Some cameras also restart numbering at 10000. (Part 4.4)
- [ ] **Never delete a photograph** — not a spoiled run, not an exposure test,
      not the dark ones at either end. The page sets aside what does not belong;
      what it cannot see is a run that is missing, because every projector after
      it can then be numbered wrongly with nothing to say so. (Part 4.3)

### Reading it back, at your desk

- [ ] **Set the camera number before you read each folder** — 1 for the first
      position, 2 for the next. The page keeps every position under its number
      until you load a plan file, and reading a number again replaces what it
      held. Until a second position is read, its report ends "Only 1 camera
      contributed": that is one position, not a fault. (Part 6)
- [ ] **If the page asks you to re-shoot a projector**, add the re-shoot to the
      folder as it says only if the tripod has not moved since. Once it has,
      **re-shoot the whole position into a fresh folder** and read it under the
      same camera number: a re-shoot from a camera that moved can still be
      matched to the run it replaces, with nothing to say so. (Part 4.2)
- [ ] **If the refusals look like a straddle, re-shoot the whole position,
      aimed, into a fresh folder, whatever the page names.** A Gray pair that
      "no longer adds up" in more than one run, or after a start you did not
      aim, is a straddle until you know otherwise: it smears the whole position,
      and the runs that passed can carry the same smear with nothing said.
      (Part 4.2)

---

## Two numbers, and why they multiply

Everything below is easier to read once these are separated, because they look
alike and are not:

| | **Camera positions** | **Projectors** |
| --- | --- | --- |
| what it is | where **you** put the tripod | what the **installation** has |
| who chooses it | you | nobody — it is bolted to the ceiling |
| how many | **three** | 2, 3 or 4 on SOS; the app's shader handles 8 |
| why that number | 1→2 positions is worth **418×**, 2→3 is worth **1.7×**, 3→8 is worth nothing measurable | it is how many projectors are in the room |

**They multiply, and here is the reason they have to.** Only one projector may be
lit at a time. The patterns address each projector's *own raster*, so two lit at
once put two different codes on the same patch of sphere and neither decodes.
Each projector therefore paints the ball alone, for its own 34 frames.

    position 1   P1: 34   P2: 34   P3: 34   P4: 34   = 136
      move the tripod
    position 2   P1: 34   P2: 34   P3: 34   P4: 34   = 136
      move the tripod
    position 3   P1: 34   P2: 34   P3: 34   P4: 34   = 136
                                                total = 408

The general form is **positions × projectors × 34**.

**Three setups, two moves.** That is the operator's physical work. The 408
exposures are about two and a half minutes per setup at one frame per second —
but read Part 6 before treating them as free: until Phase 5 lands, somebody is
pressing that shutter 408 times.

The two numbers answer different questions. **Three positions** is where the
measured return flattens, not the point at which the problem becomes solvable.
Two cameras already recover pose to 41.82 mm and three to 24.93 mm; it is ONE
camera that is degenerate, at 17 489.84 mm, because a single view cannot separate
how far a projector is from how wide its lens is (`docs/EXPERIMENT-1.md`).
**Each projector** is photographed separately so that *its own* position can be
recovered.

---

## Three rules that outrank everything else on this card

**Warm the projectors 20 minutes before anything.** NOAA's alignment manual makes
this a procedural precondition rather than advice (`docs/AMENDMENTS.md` A-23).
The same rule that governs the photometric sequence governs this one, and for a
worse reason: a capture is hundreds of frames that all have to agree with each
other, and a lamp still climbing changes the thing being measured *between* the
frames that are supposed to cancel.

**Put the camera on a tripod.** A phone sensor on a tripod recovers pose to
**4.61 mm**. The same phone handheld recovers **380–410 mm and gets no better as
resolution rises** (`docs/EXPERIMENT-1.md`). Shake is a *bias*, and resolution
only averages down *noise*, so a better camera in a hand loses to a worse one on
a tripod.

**Lock the camera and do not let it think.** This is the rule specific to
structured light and it is the one most easily broken by a camera trying to help.
Every bit the decoder reads is the **sign of the difference between a pattern and
its own complement** — that subtraction is what cancels the sphere's paint, the
room's light and the angle of the surface, none of which anyone has measured. It
cancels only if the two frames were exposed identically. **Auto-exposure,
auto-white-balance, autofocus and any adaptive noise reduction each destroy a
capture silently**, leaving photographs that look perfectly good.

---

## Part 1 · What to bring

1. **A camera you can put in full manual, and its calibration.** The calibration
   is not optional and is the item most likely to be forgotten: `SolverCameraInput`
   takes `intrinsics` — resolution, focal lengths `fx`/`fy`, principal point
   `cx`/`cy`, and the distortion terms `k1`, `k2`, `p1`, `p2` — as an **input**,
   described in its own docblock as "a calibration they already have". Arrive
   without it and there is nothing to hand the solver. Any standard checkerboard
   calibration produces these, and it must be done at **the same zoom and focus**
   you will shoot with.
2. **A camera you can put in full manual.** The sensor is not the binding term —
   error roughly halves from 320×240 to 640×480 to 1280×960 and then stops:
   2560×1920 measured *worse* than 1280×960, and a 4032×3024 phone reached only
   4.61 mm. Past about 1280×960 you are buying nothing. Bring the camera you can
   *control*, not the one with the most pixels.
3. **A tripod.** See above. Not optional, and not a monopod.
4. **An intervalometer** — continuous timed shooting, not a remote you press.
   Pressing by hand on a tripod reintroduces some of what the tripod removes,
   and `docs/EXPERIMENT-9.md` measures a hand-pressed remote as the **worst**
   arrangement of all: every capture touched at any dwell below 4 s. It fails
   more gently than a mistimed intervalometer — scattered frames rather than a
   whole position — but it fails every time. Part 4's *Starting the run* is what
   this item exists for.
5. **Floor tape and something to write with.** For marking the three positions,
   so a spoiled sequence can be re-shot from the same place — and for noting
   which side of the sphere each one is on, which Part 2 explains is a solver
   input rather than a convenience.
6. **A way to darken the room.** §5's ambient term spans 1% to 15% relative and
   is **unmeasured**. The complement trick is what makes ambient survivable at
   all; it is not a licence to work in daylight.

## Part 2 · Where to stand

**Three positions.** Going from one camera to two is worth **418×**; two to three
is worth **1.7×**; three to eight is worth nothing measurable
(`docs/EXPERIMENT-1.md`). One camera is not a hard case but a degenerate one — a
single view cannot separate a projector's distance from its field of view, and
the answer wanders along that valley.

**Roughly 120° apart, at eye height, back far enough to see the whole
silhouette.** What the measurements assumed: 1.5 m off the floor and 2.6 m from
the centre of a 68-inch sphere, scaling the distance with the radius and not the
height — 1.5 m is an operator's eye whatever the ball is doing. On a much larger
sphere a fixed 2.6 m would put you inside the rail photographing a fraction of
the silhouette.

**Keep clear of projector axes and seams where you can — which is not very
far.** Three marks 120° apart, against an axis or a seam every 45° on a
four-projector rig, fall 15° apart modulo 45°, so the best any placement can do
is clear every one of them by 7.5°. An earlier version of this card said the
experiments' placements were "deliberately offset from both". They are not: the
bench puts its cameras at 55.7°, 175.7° and 295.7° nominally, and the second
sits 4.3° from a projector's axis (`placeCameras`, `packages/bench/src/camera.ts`).
Whether lining up costs anything has never been measured.

> **You do not need to MEASURE where you stood — but you do have to know which
> side you were on.** An earlier version of this card said camera poses are
> "outputs, not inputs". That is wrong, and it is the kind of wrong that ends a
> field trip. `SolverCameraInput` takes a pose, and its docblock is precise about
> what that pose has to be right about: *"It needs to be right about which side of
> the sphere the camera was on; it does not need to be right about the distance,
> which the bootstrap corrects from the images."*
>
> So the friction this procedure genuinely does not have is the **tape measure** —
> distance and aim are recovered from the photographs. What it does have, and what
> costs nothing if you do it as you go, is **writing down roughly where each
> position was**: "north side, by the door" is enough. Lose that and the captures
> cannot be initialised, however good they are.

Mark them with tape, and label each mark. The tape is for re-shooting; the label
is a solver input.

## Part 3 · What to set on the camera

Set these once, at the first position, and then do not touch the camera again
except to move the tripod.

1. **Manual exposure.** Set it on the **all-white frame** so that nothing on the
   ball clips — clipped highlights are lost bits. The all-black frame will then
   look nearly black, which is correct and is the point.
2. **Manual focus.** Autofocus hunts on an all-black frame and may not come back
   to the same place.
3. **Manual white balance.** Auto shifts between a white frame and a Gray plane,
   which is the cancellation gone.
4. **Everything adaptive off.** HDR, scene modes, per-frame noise reduction,
   lens-correction that varies with content.
5. **The lowest ISO that still exposes** at your chosen aperture and shutter.
6. **Shoot JPEG.** This reverses what this card used to say, and the reason is
   worth reading rather than taking on trust, because the old advice was a trap.

   The decoder works in **linear light**, so something has to know which curve
   your files carry — and an earlier version of this item recommended raw on
   the grounds that raw makes that knowable. It does, for a program you write
   yourself. It does **not** help the reader you will actually use. A browser
   gets at an image through `createImageBitmap` onto a canvas, and `drawImage`
   converts its source into the canvas's colour space, so a Display P3 phone
   file or an Adobe RGB camera file is **sRGB before the page sees a pixel**.
   The reader therefore *states* sRGB rather than offering you the choice, and
   a menu that can only be set to a wrong answer is worse than no menu.

   So a raw file developed to anything but sRGB is read as though it were sRGB
   anyway — which leaves every correspondence in place while moving it, and a
   wrong curve biases the phase estimate rather than failing loudly. **Raw is
   not safer here; it is one more place to be silently wrong.**

   And precision was never the argument. With the curve known, 8-bit sRGB holds
   the decoded coordinate inside a hundredth of a projector pixel and 16-bit
   inside a thousandth — measured in a noiseless fixture where quantisation is
   the only error, so a floor rather than a promise, but against §7's 2 mm on a
   1.7 m sphere the file format is not the term that matters. **Shooting JPEG
   does not give up the calibration.**

   If you shoot raw anyway — for an archive, or because your camera's JPEG
   engine applies a picture style you cannot switch off — develop it to
   **8-bit or 16-bit sRGB** with a neutral curve and no tone mapping before the
   page sees it.

## Part 4 · The sequence, at each position

**Putting the patterns up.** On the display machine, open the projector emitter
in a browser — `/emit/` on the published site, or `/emit.html` from `npm run app`
on a laptop you can reach it from — and put the window **full-screen on the
framebuffer that drives the projectors**. That window is the projectors: SOS
drives all of them as quadrants of one X screen, so a page that fills it can
address each projector's raster without anything being installed.

It has to arrive over `http://`. Copying the folder to the machine and
double-clicking the file does **not** work — a browser will not load a page's
code from a `file://` address — so if the display machine has no route to the
site, serve the folder from a laptop on the same network rather than carrying it
across. The page says this itself if it ever fails to start, instead of showing
you a blank screen.

Tell it how many projectors the rig has and what one projector's raster is. It
will say whether each quadrant came out exactly one raster; if it did not, the
window is not the framebuffer — display scaling, or not quite full-screen — and
every frame is being resampled on its way out. Fix that before shooting.

**Then check the labels before anything else.** Step to each projector's white
frame and confirm that the projector which lights up is the one the page names.
If it is not, this display's quadrant order differs from the config's, and every
photograph afterwards would be filed under the wrong projector — which is a
confidently wrong calibration rather than a failed one.

**One projector lit at a time.** The patterns address each projector's own raster
separately, and two lit at once puts two different codes on the same patch of
sphere. The page sequences this; you never arrange it.

**Nothing but the pattern may be on screen.** Everything the page draws is light
on the ball, its own control panel included. Arm it — the panel and the cursor go
away — before the shutter opens. When the sequence ends the screen goes black,
which is the only end-of-sequence signal visible from where you are standing —
but from there not every dark sphere is the end: it looks dark on your side for
the whole run of a projector lighting its far side. The end to trust is the
page's end tone (rule 6 below).

At the page's settings the sequence is **34 frames per projector**: an all-white
and an all-black reference, then per axis six Gray planes each followed
immediately by its own complement, then four phase steps. For a four-projector
rig that is **136 frames per position, 408 in total** — about two and a half
minutes of shooting per position at one frame per second. The shooting is not the
expensive part. Moving the tripod is.

### Starting the run, which is the part most likely to cost you a position

**The page and the camera never read each other.** The emitter advances on a
timer; the camera fires on its own clock. So a shutter can open while the
projector is *changing*, and the resulting photograph is not a photograph of the
pattern it gets filed under. Every file is still present and the right size, so
the run-length check passes. The complement check does not always: a Gray plane
smeared into the frame after it misses its own identity by the fraction smeared,
so the page refuses that projector's run once a photograph is smeared by more
than about a seventh of its exposure — about a third when the smeared frame is
the complement, and more on the finest planes (`docs/EXPERIMENT-9.md`). The test
in `packages/solver/test/indexing.test.ts` pins both sides on a toy plan, not
the page's; on the page's own plan EXPERIMENT-10's T15 pins the pattern side
(`packages/experiments/test/straddle.test.ts`), and the complement side's figure
is pinned nowhere. A smaller smear is let through, and the phase frames have no
complement to be checked against at all.
Those are thresholds for one smeared photograph. When a whole position is
smeared alike, each projector's run is refused at its own smear, somewhere
between 7.0% and 16.5% of the exposure for a forward straddle, so the check
refuses such a position one run at a time (`docs/EXPERIMENT-10.md`).

`docs/EXPERIMENT-9.md` swept it. Two findings decide what you do at the tripod:

**Clock drift is not the problem.** One camera position accumulates about 27 ms
at the loosest consumer crystal, against margins of 750 ms and 1000 ms either
side of a mid-dwell shot. You do not need a better camera clock and you do not
need a tether for this.

**Where your *first* shot lands is the whole problem, and you take the gamble
three times** — the page plans one camera position's frames (136 on a
four-projector rig), stops, and you press start again at the next mark, drawing
a fresh phase each time. A shot opening at phase `p`
straddles exactly when `p > dwell − exposure`, so a start with no procedure
behind it straddles at `exposure / dwell` — **12.5%** at a 2-second dwell and a
1/4 s exposure — and compounds over three positions to **33%**:

<!-- generated: experiment-9-phase-calibrate -->
| first shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| aimed | — | 1767 (88.3%) | 116 (5.8%) | 0 (0.0%) | 0 (0.0%) |
| uniform | — | 1798 (89.9%) | 1198 (59.9%) | 728 (36.4%) | 468 (23.4%) |
| on-tick | — | 1830 (91.5%) | 9 (0.5%) | 13 (0.7%) | 20 (1.0%) |
<!-- /generated -->

Captures touched out of 2000, at the loosest crystal and a 1/4 s exposure. Same
clocks, same dwell, same exposure — **only where the first shot landed.**

**And it fails in the shape that hurts most.** With a perfect timer, which is
what EXPERIMENT-9 modelled, the phase is drawn once per position and drift
cannot walk it back out, so a position that starts inside the zone stays there
for every one of its frames: in **four in five** touched captures a whole camera
position is photographed mid-change end to end, while the other two look
perfect. The emitter is not a perfect timer (the caveat under the rules).
Replaying the same captures, EXPERIMENT-10 finds 712 of the 849 touched
positions straddled end to end at a perfect timer, and none from 3 ms per step
late: there a straddle begins part-way through a position and sweeps across it.
Either way it is one sitting at the tripod you cannot trust.

**What that costs is measured now, on the bench, against a reader that places
every run.** Until now this card said nobody had measured it.
`docs/EXPERIMENT-10.md` rendered these photographs and handed them to the page's
own complement check and decoder, told what kind each photograph is — the
table's *counterfactual reader* — because the page's reader then refused all 108
clean positions rendered from this card's three marks before the check ran. The
page's reader has since been replaced and places those positions (the top of
this card), but nobody has yet handed it a straddled one, so this table is still
the counterfactual's. EXPERIMENT-9's captures at the page's defaults come out
like this, with a perfect timer and with the emitter running late:

<!-- generated: experiment-10-rescore-calibrate -->
| start, emitter | captures flagged or changed | refused loudly (share, 95% CI) | of those, run by run | pass silently | past the 1 mm seam gate |
| --- | --- | --- | ---: | --- | --- |
| aimed start, perfect timer (R8) | 0 of 2000 | 0 | 0 | 0 placed (not solved) | — |
| aimed start, 2 ms late per step (L-aimed-2) | 0 of 2000 | 0 | 0 | 0 placed (not solved) | — |
| aimed start, 7.5 ms late per step (L-aimed-7.5) | 1786 of 2000 (1786 newly touched) | 1358 (76.0%, 73.8–78.1%) | 1358 | 324: 4 harmless, 2 biased, 17 gate-breaking, 301 not solved | 28 under P; 40 of the 58 solved under A |
| un-aimed (uniform) start, perfect timer (R1) | 728 of 2000 | 627 (86.1%, 83.7–88.5%) | 295 | 98: 38 harmless, 17 biased, 43 gate-breaking | 61 |
| un-aimed (uniform) start, 2 ms late per step (L-uniform-2) | 1249 of 2000 (521 newly touched) | 912 (73.0%, 70.7–75.3%) | 637 | 240 placed (not solved) | — |
| un-aimed (uniform) start, 7.5 ms late per step (L-uniform-7.5) | 1893 of 2000 (1165 newly touched) | 1693 (89.4%, 88.1–90.8%) | 1637 | 116 placed (not solved) | — |

_Policy P, the counterfactual reader. The aimed start protects while the emitter runs less than about 3.50–3.70 ms late per step (derived); 1% of aimed captures are touched from 3.6 ms (swept). The emitter’s lateness has been measured only headless: a design-time 7.5 ms per step, and about 9.3 ms armed with the tick on._
<!-- /generated -->

*Loud* is a refusal when you read the folder; *silent*, a position that passes
with no message. Policy P re-shoots each refused position whole and assumes the
re-shoot is clean, which is optimistic; policy A keeps what a partly refused
position placed, as the page would decode it. What it means for you:

- **Most straddled captures are refused, and a run refused on its own is
  mostly blamed on the wrong thing.** With no aimed start and a perfect timer,
  627 of the 728 touched are refused: 332 as whole positions, and 295 run by
  run, each told that the photographs look like a dropped and a duplicated
  frame, which is not what happened, and to "Re-shoot projector N" — the words
  the page's own check still uses. The page now reads that one projector's
  re-shoot, added to the folder. After a straddle it is still the wrong remedy:
  a straddle smears the whole position, each run is refused at its own smear,
  and the runs that passed can carry the same smear with nothing said.
  **Re-shoot the whole position, aimed, into a fresh folder** — added to the old
  folder, a re-shot run that straddles again leaves the page using the smeared
  run that passed, with a note rather than a refusal.
- **Most of what passes is not harmless.** A straddle the check lets through
  still decodes, but shifted: smeared by 6% of the exposure, it moves the
  worst seam point 6.8 times as far as re-shooting the position would, and 43 of
  the 98 captures that passed silently put the seams past the 1 mm gate.

So, three rules, in the order they pay:

1. **Aim the first shutter at the middle of the first frame, and do it by
   controlling `Play` rather than the camera.** Start the intervalometer, let it
   settle into its rhythm, and press `Play` about **half a dwell after you hear
   a shot**. The next release then lands mid-frame with the whole safe window
   either side of it. That is the `aimed` row: **0.0% at a 2-second dwell.**

   **Do not instead wait for a tick and trip the shutter on it**, which is the
   obvious reading of the `on-tick` row and is wrong for two reasons. The page
   plays its tone *at* an advance and does not play one when the sequence
   begins — `start()` shows frame 0 silently — so the first tone you hear is the
   step onto frame 1, and a capture begun there is **missing its white frame**,
   the reference every later frame is read against. And even where it applies,
   `on-tick` only reaches 0.7%: it puts the shutter a reaction time above a
   boundary, which is why that row gets slightly *worse* as the dwell lengthens
   — drift scales with the dwell and a reaction time does not.

   What the tone is genuinely for is the rest of the run. Once the shutter is
   falling between steps, hearing the step and the shutter stay apart is the
   only confirmation available to somebody standing in the dark with an armed
   page showing nothing.
2. **Keep the dwell at 2 seconds or more.** The safe window is `dwell − exposure`
   wide. The page will let you take it to 0.2 s and says nothing about what that
   spends; at 0.5 s a capture is touched about nine times in ten however you
   start it.
3. **Do not press a remote by hand for each frame.** It is the worst arrangement
   measured — every capture touched at any dwell below 4 s — though it fails
   differently, in scattered frames rather than whole positions, and never loses
   a position end to end.

**One caveat on the first rule, found by reading the page: it assumes the
emitter keeps time, and the emitter runs late.** In `emit.ts`, `advance()`
draws each frame and only then re-arms its timer for the next dwell, so every
step lasts the dwell *plus* however long the drawing took, and the lateness adds
up across a position. The camera, on its own clock, then fires progressively
earlier within each step. An `aimed` start sits at least a quarter of a dwell
from the start of its step, so it protects fully only while the lateness stays
under about **3.50 to 3.70 ms per step at a 2-second dwell** — half a second
spread over 135 steps, the lower figure for a camera whose clock runs fast. The
only figures for the lateness come from a headless browser, which is not your
display machine: 7.5 ms per step with the page unarmed and the tick off, and
about 9.3 ms armed with the tick on, which is how this card has you run it. At
7.5 ms, 1786 of 2000 aimed captures are touched (EXPERIMENT-10's table, above),
and the display machine's number is unmeasured. **So the aimed start is
necessary, and not yet sufficient.** A **4-second dwell doubles the margin**,
though by the same arithmetic not past either headless figure. The real fix
belongs in the page — timing every step from the moment `Play` was pressed
rather than re-arming after each paint.

**Nothing checks this on the day, and afterwards, even given a reader that can
place runs, only the larger smears are caught.** Everything in EXPERIMENT-10's
table is found at your desk or not at all: a loud capture is a return trip, and
a silent one is never reported. At the sphere, the rules above are the whole
defence.

Then, in order:

1. Shoot every frame **in strict capture order**. The order is still what the
   software counts from inside a run.
2. **If you spoil a frame, do not try to patch the run — re-shoot that
   projector's whole run into the same folder, before you move the tripod.**
   Press **Home**, then `]` until the page shows that projector's white, start
   the intervalometer, and press `Play` half a dwell after a shot, as at the
   start. Let the page play on to the end — every later projector's run it
   shoots again is matched the same way, and each projector's latest run that
   passes is the one used — or stop the camera once that projector's run is
   done. Stop the camera, not the page: a paused page is photographed again on
   the run's last frame, and that reads as one photograph too many. Leave the
   spoiled run where it is. The page matches each re-shot run to its projector
   by comparing it with the photographs already there, and reads it in place of
   the spoiled run if it passes its checks. On the bench's rendered photographs,
   the run shot again from where the camera stood, every such folder read as its
   position with the re-shot run in place: 150 of 150 with the run added after
   the position, and 150 of 150 with the page played on to the end
   (`experiments/reader-acceptance.json`). With the run spoiled first, one of
   its photographs shot twice or not at all, 300 of 300 read so with the re-shoot
   added after the position and 298 of 300 with the page played on; the other 2
   were refused, and none was misfiled. A re-shot run handed in on its own is
   refused, with how to hand it in.

   **Before you move the tripod**, because that match is by what the camera saw,
   and it cannot tell a camera that moved. On the bench's rendered photographs, a
   re-shoot from a camera turned half a degree was still matched in 139 of 140
   runs, and from one turned five degrees in 67 of 140; the page used it each
   time it matched, and what a run from another pose costs the solve is
   unmeasured. Once
   the tripod has moved — you are back another day, or the page asked for the
   re-shoot at your desk — re-shoot the whole position into a fresh folder
   instead, and read it under the same camera number, which replaces what that
   number held.

   **After a straddle, re-shoot the whole position, aimed, into a fresh folder,
   whatever the refusal names.** When the refusals are Gray pairs that no longer
   add up, in more than one run, or follow a start you did not aim, treat them
   as a straddle: it smears the whole position, each run is refused at its own
   smear (above), and the runs that passed can carry the same smear silently.
   Re-shooting only the projectors named keeps those runs; adding the re-shoot
   to the old folder lets a re-shot run that straddles again leave the page
   using the smeared run that passed, with a note rather than a refusal.

   This card used to say to re-shoot the whole position for every spoiled
   frame, because the page's old reader read a position only as exactly one run
   per projector: `docs/EXPERIMENT-10.md` built a re-shot run appended and
   alone, for every projector, and that reader refused all 192 such folders
   whole. The page's reader now reads the appended one. The whole position is
   still the answer to a straddle, for the straddle's sake. Patching is still
   the worse error, and it
   is worth knowing exactly why. Software can find each projector's run by its
   white and black frames and check the count between them, so a frame you
   simply *lose* costs that projector's run and nothing else. What the count
   cannot see is a frame lost and another added **in the same run**: it still
   adds up, and every frame still looks like a patterned frame.
   `docs/EXPERIMENT-8.md` measures that coming back wrong in 22.7% of such
   sessions against the bookends alone, and 1.1% once the complement check is
   added.
3. **Never delete a photograph** — not a spoiled run, not an exposure test, not
   the dark ones at either end. A frame *lost* inside a run is survivable and a
   patched one is not, but the page numbers projectors by counting runs and the
   photographs between them, so a run deleted from the folder is the one fault
   it cannot catch: every projector after it can then be numbered wrongly with
   nothing to say so. What does not belong — photographs taken before `Play`, a
   test shot before the first run, dark ones after the screen went black — it
   recognises and sets aside: on the bench's rendered photographs, a test shot
   of another projector's white before `Play` in 112 folders of 112, and in 112
   more with that projector re-shot and added after the position, whose re-shoot
   it still matched. An earlier version of this card said "If you
   delete, delete; do not also add". Deleting is now the mistake.
4. Make sure filenames **sort in capture order**. Most cameras do this; some
   restart numbering at 10000.

   **And know what that rule actually protects.** The reader does not sort your
   files — `readCapture`'s own docblock is explicit that it decodes what it was
   handed, because a reader that quietly sorted would put `IMG_10` before
   `IMG_2` and "produce a capture that decodes — wrong, and with nothing in the
   output saying so". The page passes on the order your **file picker** hands
   it. So a dialog sorted newest-first hands in a reversed position, and
   well-named files do not save you. Select them from a dialog sorted by
   **name, ascending**, and hand in one camera position at a time.
5. Do not move the tripod within a position. Move it only between positions,
   and only once any re-shoot of the position you are at is done (rule 2).
6. **Photograph the whole sequence, from before `Play` to the page's end tone,
   and keep the extras at either end few.** The end of the position is the
   page's end tone, not the sphere going dark on your side. You stand at one
   camera, and from there the sphere looks dark for the whole run of a
   projector lighting its far side: that is a projector this camera cannot
   see, still playing, and its run must still be photographed — its dark
   photographs are how the page counts it. With the tick on, every step ticks
   and the end is a lower, longer tone, as the page paints the screen black
   (`advance()` in `emit.ts`). And the camera starts before `Play`, as the
   aimed start has it.

   Keep the photographs taken after the screen went black. The page sets aside
   the photographs before you pressed `Play` and the dark ones after the black,
   each with a note, and notes a projector this camera could not see rather
   than refusing it. What it cannot always tell is which is which: a projector
   out of view is a run of dark photographs, and at either end of the folder it
   looks just like extras. So do not start the intervalometer long before you
   press `Play`, and stop it soon after the end tone — **under about 30 at each
   end** with the default plan of 34 frames a projector, about a minute at a
   2-second dwell, and well under one projector's run with any plan. A long run
   of extras can leave the page unable to tell which projector is which, and it
   refuses the folder rather than guess — while nothing is missing at the other
   end. A camera started after `Play` loses photographs at the front of the
   folder, and one stopped when the sphere went dark on your side loses them at
   the back; where the projector there is one this camera cannot see they are
   dark, and nothing in the folder says they are gone. Four or more of those
   lost at one end, with more than 30 extras at the other, read by count
   exactly like a folder numbered a projector over, and the page can file every
   run under the wrong projector with nothing to say so (`indexPosition`'s
   docblock, `packages/solver/src/indexing.ts`). With only three extras at the
   other end it misfiles nothing: on the bench's rendered photographs, a camera
   started 1, 2, 4 or 8 photographs after `Play`, or stopped as many early, in
   384 folders, read as its position in 48 — each only 1 or 2 out, where the
   projector at that end was out of view or barely seen — and was refused in
   words in the other 336.

   An earlier version of this card said to delete the photographs after the
   black, because the page's old reader counted the last run to the end of the
   folder and dropped it. The page's reader no longer does: on the bench's
   rendered photographs every folder with none, one or three photographs before
   `Play` and none, one or two after the black read as its position, 432 of 432.

## Part 5 · What good looks like, before you leave

Check these on the camera while you can still re-shoot:

- **The white frame is clipped nowhere** in the patch it lights. Only one
  projector is on, so that patch is a *crescent* on one side of the ball and not
  the whole sphere — the capture path calls it exactly that. A frame that is dark
  outside the crescent is correct, not a failure; a frame that is blown out inside
  it has lost bits.
- **The black frame is nearly black.** What it is not is a room-light meter on its
  own: it carries the room AND the projector's own black floor, which are
  different terms. `docs/VISIT.md` Part 3 item 1 separates them by shooting full
  black with the projectors ON and then OFF, and A-29 treats that pair as one
  joint measurement. If the black frame looks grey, shoot it again with the
  projectors off before blaming the room.
- **The finest Gray plane's stripes are clearly separated**, several pixels wide,
  not a shimmer. If they alias, the camera is too far away or too low-resolution
  for this many planes.
- **The whole silhouette is in frame**, with some room behind it.

## Part 6 · How much of this is permanent

Most of this card is not a description of the job. It is scaffolding standing in
for software that does not exist yet, and it should get shorter as the phases in
`docs/OPERATOR-PATH.md` land. Which rule each phase deletes:

| rule on this card | survives? |
| --- | --- |
| Shoot in strict order | **Phase 2 softened it, and cannot yet delete it.** The run's own references re-synchronise the count, so a lost frame costs that projector's run instead of the capture — but the order is still what indexes frames inside a run |
| Never patch a run | **Phase 2 narrowed it** to: do not lose one frame and add another in the same run, and the page now catches most of even that. Still worth keeping — what it catches, it catches by refusing that run, which costs a re-shoot |
| Never delete a photograph | **survives while projectors are numbered by counting.** A deleted run is the one fault the page's reader cannot catch: the projectors after it can be numbered wrongly with nothing to say so |
| Re-shoot a spoiled projector into the same folder, before the tripod moves | **survives, and is the page's own remedy now.** It reads the re-shot run in place of the spoiled one; the tripod is what keeps that safe, because the page cannot tell a re-shoot from a camera that moved |
| Re-shoot the whole position, aimed, after a straddle | **goes with the aimed start, when Phase 5's done-when is met.** Until nothing can start mid-change, a straddle smears the runs that pass as well, and nothing on the page says so |
| Keep the extras at either end few | **survives for now, and is looser than it was.** It used to be *delete the photographs after the screen goes black*, because the page counted the last run to the end of the folder. Its reader sets extras aside now, but cannot tell dark extras from a projector out of view at the same end |
| Start the camera before `Play` and stop it after the end tone | **Phase 5 could delete it** — a tethered camera is tripped by the laptop that advances the pattern. Until then a dark end cut short looks the same as a whole one, and the page's reader cannot tell them apart |
| Set the camera number for each position, from 1 | **Phase 5 could delete it** — a tethered camera is known to the software driving it. Until then nothing in a photograph says which camera took it (below) |
| Make sure filenames sort in capture order | **Phase 2 softened it** — a run is found by its references, not by its filenames — but the order inside a run still comes from them |
| One projector lit at a time | **Phase 1 deleted it as a task.** Still true of the physics; the emitter sequences it and the operator never arranges it |
| Count 34 frames per projector at each position | **Phase 1 deleted it.** The page counts, and can tick so you need not watch it |
| Check on the camera what "good" looks like | **Phase 3 narrowed it.** The software reads the capture and says what survived — but only once you are home, so the on-camera checks are still what saves a second trip |
| Aim the first shutter at mid-frame by timing `Play` | **Phase 5's done-when, and not met.** `docs/EXPERIMENT-9.md` measured it; nothing was built. The page neither stops you starting anywhere nor says what it costs, so on the day this rule is the whole defence |
| Keep the dwell at 2 s or more | **same.** The emitter lets you set 0.2 s and says nothing about what that spends against your exposure |
| Press the shutter 408 times | **Phase 5 deletes it** |
| Set exposure, focus and white balance by hand | **Phase 5 narrows it** to confirming what the software proposes |
| Warm the projectors 20 minutes | **permanent.** Lamp physics |
| Tripod, not hands | **permanent.** Shake is a bias |
| Darken the room | **permanent.** §5's ambient is unmeasured |
| Lock the camera; nothing adaptive | **permanent** as a requirement, even when a tether is what enforces it |

So four rules are the job and the rest is the tooling's absence. **The end state
is: warm the projectors, darken the room, put a locked camera on a tripod, press
start three times, and say yes or no to a before-and-after.**

**And the two tripod moves may go too.** Once frames identify themselves —
Phase 2 — a second and third camera cost mostly hardware. Three cameras on three
tripods shooting the same sequence is **one pass and no moves at all**, which is
hardware traded for time.

What it is *not* is three anonymous folders. Each camera is a separate solver
input with **its own** intrinsics and its own which-side-of-the-sphere pose, so
the folders have to stay associated with the camera that made them. Phase 2
removes the need to know which *frame* a photograph is; it does not remove the
need to know which *camera* took it.

## Part 7 · What this card cannot tell you yet

Stated as gaps rather than omitted, because an operator who discovers them at the
sphere has wasted a trip:

- **Whether a patched run is wrong — mostly you can now find out.** Phase 2
  finds each projector's run, checks its length, and asks whether each pattern
  and its complement still add up to the run's own white and black. A frame
  lost and another added inside one run satisfies the first two and is caught
  by the third, and the page names the projector to re-shoot and reads the
  re-shoot added to the folder (Part 4.2). **What it still
  cannot see** is a fault that disturbs no complementary pair — in the plan this
  page writes, the phase frames rearranging among themselves. And it is a
  refusal, not a repair: a run it doubts is dropped, not fixed.

  **Still true on the day:** none of this happens at the sphere. You hand the
  folder in when you are home, so the rules in Part 4 are what protect the trip.
  Nothing connects the emitter's own step count to the files on your card.
- **Whether your capture decoded — never on the day, and on a real sphere not
  yet by anybody.** The emitter page reads a folder: hand it `capture-plan.json`
  and one camera position's photographs, with its camera number set, counted
  from 1. On the bench's rendered captures it places every clean position (the
  top of this card); no real photograph has been through it. Two more things are
  worth knowing. It keeps every position you read under its camera number until
  you load a plan file — the same file loaded again included — and its report
  covers all of them, so until a second position is read the report ends "Only 1
  camera contributed … A second camera position is needed: hand in its
  photographs, or shoot one.": the report needs two cameras before it will vouch
  for a solve, so that line means one position has been read, not that your
  photographs are at fault (`packages/solver/src/worth.ts`). And **where** you
  can run it is not at the sphere: the page that reads photographs is the page
  full-screen across the projectors, and you will be at a desk before you use
  it. So the on-camera checks in Part 5 remain the only thing standing between
  you and a second trip.

  And it stops before a pose. Correspondences are not a projector position —
  that needs the intrinsics and the rough which-side pose this card tells you to
  bring, which the reader does not yet accept.
- **What to do when it fails, beyond the first sentence.** A refusal now names
  the rejection that dominated — the light never reached those pixels, the finest
  stripes were finer than the camera could resolve, the Gray address and the
  phase disagreed — which points at the projector, the tripod distance or the
  indexing respectively. Whether those pointers are the right ones on a real
  capture is untested.
- **What accuracy to expect on a real sphere.** Nobody has run one. Every figure
  quoted on this card is simulated, and is the best available prediction rather
  than a result.
- **Whether a rig of more than four projectors can be written back.** It can be
  photographed and solved, and the **SOS config file format carries four**. See
  `docs/OPERATOR-PATH.md`.
- **How to undo an install — the copies can be complete now; putting them back
  is still by hand.** The archive holds your config, which it patches rather than
  rewrites. The warp meshes and alignment files it *generates*, so it has never
  seen what sits at those paths on your sphere — and for a long time that made a
  complete restore impossible, which `restore/MANIFEST.txt` said in as many
  words. The panel now has a second picker: hand it your current warp and
  alignment files and copies of **all five** originals travel in the archive,
  with a line saying installing is reversible. Until you do, the refusal still
  names exactly which paths are uncovered.

  What has **not** changed is that putting a file back is you copying it out of
  `restore/`. A browser cannot write to the sphere's filesystem, so "one step"
  has to mean a script the archive carries or an installer somebody runs, and
  neither is built. **Copy anything you are about to overwrite somewhere safe
  yourself, before you copy a single file in.** This card will say so until
  there is an action rather than a folder.
