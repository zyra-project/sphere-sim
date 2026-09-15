# Calibrating a sphere — field card

What to do at the sphere, in the order to do it, to capture a structured-light
calibration. Companion to `docs/VISIT.md`, which is a different errand: that card
*measures an installation to check the model*, this one *photographs an
installation to recover its geometry*.

> **This procedure cannot be completed today.** Phases 1 to 3 of
> `docs/OPERATOR-PATH.md` have landed far enough to matter: there is a supported
> way to put the patterns on the sphere (Part 4), software can work out which
> projector's run a photograph belongs to, and the arithmetic that turns encoded
> photographs into the correspondences a solve needs exists and agrees with
> itself end to end. Two things have **not** happened. None of it has met a real
> room: every photograph the chain has ever read was synthesised. And none of it
> is reachable — no code here reads a folder, the ingest modules are called only
> by a test, and Phases 4 and 5, the before-and-after and the way to install a
> result, are not built. So a capture made today is worth making, and turning it
> into a calibration is still a thing nobody can do.
>
> It is written anyway, and first, for two reasons. It is the cheapest way to find
> out what the procedure gets wrong — cheaper than building three phases and then
> discovering the card is wrong. And the discipline items below are exactly what
> decides whether a capture made now is still usable when Phase 3 lands, so a
> careful capture today is not wasted.

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
4. **A remote release or self-timer.** Pressing the shutter by hand on a tripod
   reintroduces some of what the tripod removes.
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
6. **Raw, if the camera offers it — for the transfer, not for the bit depth.**
   The decoder works in **linear light**, and the ingest will not run without
   being told which curve your files are encoded with. Raw makes that knowable;
   a JPEG has usually been through sRGB but may also carry a picture style or a
   tone curve nobody wrote down, and a wrong curve biases the phase estimate.

   What raw is **not** needed for is precision. With the curve known, 8-bit sRGB
   holds the decoded coordinate inside a hundredth of a projector pixel and
   16-bit inside a thousandth — measured in a noiseless fixture where
   quantisation is the only error, so a floor rather than a promise, but against
   §7's 2 mm on a 1.7 m sphere the file format is not the term that matters.
   **If the choice is between a JPEG you can identify and a raw workflow you
   cannot complete, shoot the JPEG.**

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
| Never delete, skip or re-shoot one frame | **Phase 2 narrowed it** to: do not delete one and add another in the same run. That is the one fault the bookends cannot see |
| Re-shoot a whole projector's 34 if you spoil one | **survives for now.** Phase 2 made it cheap rather than unnecessary |
| Make sure filenames sort in capture order | **Phase 2 softened it** — a run is found by its references, not by its filenames — but the order inside a run still comes from them |
| One projector lit at a time | **Phase 1 deleted it as a task.** Still true of the physics; the emitter sequences it and the operator never arranges it |
| Count 34 frames, 136 per position | **Phase 1 deleted it.** The page counts, and can tick so you need not watch it |
| Check on the camera what "good" looks like | **Phase 3 narrowed it.** The software reads the capture and says what survived — but only once you are home, so the on-camera checks are still what saves a second trip |
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

- **Whether a patched run is wrong.** Phase 2 got as far as finding each
  projector's run and checking its length, which is why Part 4's rules are looser
  than they were. It cannot see a frame deleted and another added inside one run,
  and it will not tell you that it cannot. Nothing here connects the emitter's
  own step count to the files on your card.
- **Whether your capture decoded, on the day.** The arithmetic for this exists —
  how many points survived, from how many camera and projector pairs, which
  cameras contributed nothing, and a refusal rather than a pose when nothing
  decoded or when a projector was seen by only one camera. What does not exist
  is any way for you to run it. Nothing in the repository reads a folder of
  photographs; the modules are reachable only from code somebody has yet to
  write. So on the day you will know exactly what you know now, which is
  nothing, and you will find out when you are back at a desk — and even then
  only whether it holds on synthesised frames, because no real ones have been
  through it.
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
- **How to undo an install.** The archive now tells you which of the files it
  writes it could put back, and it is currently one of them: your config, which
  it patches and therefore holds a copy of. The warp meshes and alignment files
  it generates, so it has never seen what is at those paths on your sphere and
  cannot return them. `restore/MANIFEST.txt` names them. **Copy anything you are
  about to overwrite somewhere safe yourself, before you copy a single file in.**
  There is no one-step way back and this card will say so until there is.
