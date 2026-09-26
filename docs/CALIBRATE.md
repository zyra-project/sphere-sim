# Calibrating a sphere — field card

What to do at the sphere, in the order to do it, to capture a structured-light
calibration. Companion to `docs/VISIT.md`, which is a different errand: that card
*measures an installation to check the model*, this one *photographs an
installation to recover its geometry*.

> **What a capture is worth today, and what it still is not.** Phases 1 to 3 of
> `docs/OPERATOR-PATH.md` have landed: there is a supported way to put the
> patterns on the sphere (Part 4), the emitter writes the plan down beside your
> photographs, and **the same page reads a folder of them back** — finding each
> projector's run, checking every Gray plane against its own complement,
> decoding the runs it can vouch for, and reporting what the capture was worth.
> Earlier versions of this card said no code here read a folder. That stopped
> being true and the card did not notice, which is the kind of drift Part 7
> exists to prevent.
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
> read was synthesised: flat albedo, constant ambient, no sensor noise, no limb,
> nobody walking through. So the most valuable thing a capture made today
> produces is not a calibration. It is the first evidence about whether any of
> this survives a real sphere — and that is worth more than the calibration,
> because every number on this card is currently a prediction.

---

## The day, in one page

**Everything after this section is *why*. This is *what*.** Each line names the
Part that argues for it, so a rule you doubt can be checked rather than obeyed.

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
      frame. This one line is the cheapest thing on this card: it is the
      difference between **one capture in three silently ruined and none.**
      (Part 4, *Starting the run*)
- [ ] **Then do not touch anything.** 136 frames, about 4½ minutes at a 2-second
      dwell. The tone marks each step, so you can hear that the shutter is still
      falling between steps rather than on them.
- [ ] **The screen goes black when the position is done.** That is the only
      end-of-sequence signal visible from where you are standing.
- [ ] Stop the intervalometer, then **check on the camera before you move**
      (Part 5): white frame not clipped inside the crescent, black frame nearly
      black, finest stripes clearly separated rather than shimmering, whole
      silhouette in frame.
- [ ] Move the tripod to the next mark. Press **Home** to return the page to
      frame 0, and repeat from *Arm*.

### Before you leave the sphere

- [ ] **Three folders, one per position**, each carrying `capture-plan.json` and
      each labelled with the side of the sphere it was shot from.
- [ ] **Filenames sort in capture order**, and when you hand them in, **select
      them from a dialog sorted by name, ascending.** The page reads them in the
      order your file picker gives it, not in an order it works out for itself.
      Some cameras also restart numbering at 10000. (Part 4.4)
- [ ] **If you spoiled a frame: re-shoot that projector's whole 34 and keep both
      runs.** Delete if you must; never delete one and add another in the same
      run. (Part 4.2)

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

**Do not line up with a projector or with a seam.** The three placements the
experiments use are deliberately offset from both.

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
which is the only end-of-sequence signal visible from where you are standing.

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
pattern it gets filed under. Every file is still present, every file is still
the right size, and the software's run-length and complement checks all pass —
`docs/EXPERIMENT-8.md`'s blind spot, reached without anybody deleting anything.

`docs/EXPERIMENT-9.md` swept it. Two findings decide what you do at the tripod:

**Clock drift is not the problem.** One camera position accumulates about 27 ms
at the loosest consumer crystal, against margins of 750 ms and 1000 ms either
side of a mid-dwell shot. You do not need a better camera clock and you do not
need a tether for this.

**Where your *first* shot lands is the whole problem, and you take the gamble
three times** — the page plans 136 steps, stops, and you press start again at
the next mark, drawing a fresh phase each time. A shot opening at phase `p`
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

**And it fails in the shape that hurts most.** The phase is drawn once per
position and drift cannot walk it back out, so a position that starts inside the
zone stays there for all 136 of its frames: **four in five** touched captures
lose at least one camera position end to end, while the other two look perfect.
A night's shooting is not all-or-nothing — it is one sitting at the tripod
silently thrown away.

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

**None of this is checked on the day, or afterwards.** A straddled frame is
counted by that experiment as an event in time, not as a decoded error; what it
costs a calibration has never been measured, because nothing has yet rendered a
blend and pushed it through the decoder. The honest claim is the narrow one:
this many photographs are not photographs of the pattern they are filed under.

Then, in order:

1. Shoot every frame **in strict capture order**. The order is still what the
   software counts from inside a run.
2. **If you spoil a frame, do not try to patch the run — re-shoot that
   projector's whole 34**, and keep both runs. This is the one rule that carries
   real risk, and it is worth knowing exactly why. Software can now find each
   projector's run by its white and black frames and check the count between
   them, so a frame you simply *lose* costs that projector's run and nothing
   else. What it cannot see is a frame lost and another added **in the same
   run**: the count still adds up, every frame still looks like a patterned
   frame, and the capture comes back wrong with nothing saying so.
   `docs/EXPERIMENT-8.md` measures that at 22.7% of such sessions.
3. A deleted frame is therefore **survivable and a patched one is not.** If you
   delete, delete; do not also add.
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
5. Do not move the tripod within a position. Move it only between positions.

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
| Never delete, skip or re-shoot one frame | **Phase 2 narrowed it** to: do not delete one and add another in the same run, and the page now catches most of even that and tells you which projector to re-shoot. Still worth keeping — what it catches, it catches by refusing that run |
| Re-shoot a whole projector's 34 if you spoil one | **survives for now.** Phase 2 made it cheap rather than unnecessary |
| Make sure filenames sort in capture order | **Phase 2 softened it** — a run is found by its references, not by its filenames — but the order inside a run still comes from them |
| One projector lit at a time | **Phase 1 deleted it as a task.** Still true of the physics; the emitter sequences it and the operator never arranges it |
| Count 34 frames, 136 per position | **Phase 1 deleted it.** The page counts, and can tick so you need not watch it |
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
  deleted and another added inside one run satisfies the first two and is caught
  by the third, and the page names the projector to re-shoot. **What it still
  cannot see** is a fault that disturbs no complementary pair — in the plan this
  page writes, the phase frames rearranging among themselves. And it is a
  refusal, not a repair: a run it doubts is dropped, not fixed.

  **Still true on the day:** none of this happens at the sphere. You hand the
  folder in when you are home, so the rules in Part 4 are what protect the trip.
  Nothing connects the emitter's own step count to the files on your card.
- **Whether your capture decoded — afterwards, yes; on the day, no.** The
  emitter page now reads a folder: hand it `capture-plan.json` and one camera
  position's photographs and it reports how many points survived, from how many
  camera and projector pairs, which cameras contributed nothing, and a refusal
  rather than a number when nothing decoded or when a projector was seen by only
  one camera. Earlier versions of this card said no such thing existed. What is
  still true is **where** you can run it: not at the sphere. The page that reads
  photographs is the page that is full-screen across the projectors, and you
  will be at a desk before you use it. So the on-camera checks in Part 5 remain
  the only thing standing between you and a second trip.

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
