# Calibrating a sphere — field card

What to do at the sphere, in the order to do it, to capture a structured-light
calibration. Companion to `docs/VISIT.md`, which is a different errand: that card
*measures an installation to check the model*, this one *photographs an
installation to recover its geometry*.

> **This procedure cannot be completed today.** Phases 1, 2 and 3 of
> `docs/OPERATOR-PATH.md` are not built: nothing puts the patterns on the sphere,
> nothing works out which pattern a photograph shows, and the solver has never
> been given a real photograph. Following this card today produces **a folder of
> photographs that nothing can currently read.**
>
> It is written anyway, and first, for two reasons. It is the cheapest way to find
> out what the procedure gets wrong — cheaper than building three phases and then
> discovering the card is wrong. And the discipline items below are exactly what
> decides whether a capture made now is still usable when Phase 3 lands, so a
> careful capture today is not wasted.

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

1. **A camera you can put in full manual.** The sensor is not the binding term —
   error roughly halves from 320×240 to 640×480 to 1280×960 and then stops:
   2560×1920 measured *worse* than 1280×960, and a 4032×3024 phone reached only
   4.61 mm. Past about 1280×960 you are buying nothing. Bring the camera you can
   *control*, not the one with the most pixels.
2. **A tripod.** See above. Not optional, and not a monopod.
3. **A remote release or self-timer.** Pressing the shutter by hand on a tripod
   reintroduces some of what the tripod removes.
4. **Floor tape.** For marking the three positions, so a spoiled sequence can be
   re-shot from the same place.
5. **A way to darken the room.** §5's ambient term spans 1% to 15% relative and
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

> **You do not need to measure where you stood.** The solve *estimates* the
> camera poses; they are outputs, not inputs. What matters is that the three
> positions are genuinely different from each other, not that any of them is in a
> particular place. This is the single largest piece of friction this procedure
> does *not* have, and it is worth knowing before you start looking for a tape
> measure.

Mark them with tape anyway. That is for re-shooting, not for accuracy.

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
6. **Raw, if the camera offers it.** The decoder works in **linear light**. A
   JPEG has been through a transfer nobody wrote down, and the phase estimate is
   biased by exactly that. Raw makes the transfer knowable instead of a guess.

## Part 4 · The sequence, at each position

**One projector lit at a time.** The patterns address each projector's own raster
separately, and two lit at once puts two different codes on the same patch of
sphere.

At the page's settings the sequence is **34 frames per projector**: an all-white
and an all-black reference, then per axis six Gray planes each followed
immediately by its own complement, then four phase steps. For a four-projector
rig that is **136 frames per position, 408 in total** — about two and a half
minutes of shooting per position at one frame per second. The shooting is not the
expensive part. Moving the tripod is.

Then, in order, and this is where the missing Phase 2 costs you:

1. Shoot every frame **in strict capture order**.
2. **Do not delete, skip or re-shoot a single frame mid-sequence.** Nothing yet
   reads which pattern a photograph shows, so today the *order* is the only
   record of it. One deleted frame silently renumbers everything after it, and a
   mis-indexed Gray plane is not a failed calibration — it is a confident wrong
   one.
3. If you spoil a frame, **re-shoot that projector's whole 34** and keep both
   runs. Sorting it out later is possible; guessing which frame was replaced is
   not.
4. Make sure filenames **sort in capture order**. Most cameras do this; some
   restart numbering at 10000.
5. Do not move the tripod within a position. Move it only between positions.

## Part 5 · What good looks like, before you leave

Check these on the camera while you can still re-shoot:

- **The white frame is bright everywhere on the ball and clipped nowhere.**
- **The black frame is nearly black.** If it is visibly grey, the room is too
  light and every later frame is sitting on a pedestal.
- **The finest Gray plane's stripes are clearly separated**, several pixels wide,
  not a shimmer. If they alias, the camera is too far away or too low-resolution
  for this many planes.
- **The whole silhouette is in frame**, with some room behind it.

## Part 6 · What this card cannot tell you yet

Stated as gaps rather than omitted, because an operator who discovers them at the
sphere has wasted a trip:

- **How to get the patterns onto the projectors.** Phase 1. Today there is no
  supported way; the sequence exists only inside the page.
- **Whether your capture decoded.** Phase 3. Nothing will read these photographs,
  so there is no answer to take home.
- **What to do when it fails.** Phase 3 is also where a refusal gets a reason —
  how many correspondences survived, from how many pairs, which cameras
  contributed nothing.
- **What accuracy to expect on a real sphere.** Nobody has run one. Every figure
  quoted on this card is simulated, and is the best available prediction rather
  than a result.
- **Whether a rig of more than four projectors can be written back.** It can be
  photographed and solved, and the **SOS config file format carries four**. See
  `docs/OPERATOR-PATH.md`.
