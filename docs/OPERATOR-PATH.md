# Calibrating a real sphere — the operator path

**Status: Phases 0 and 1 landed — `docs/CALIBRATE.md` and the projector emitter.
Phase 2 is measured but not settled: the two cheap mechanisms are built and
scored, and they leave a blind spot that needs a real sphere to price. Phase 3 is
plumbed and now reachable but still unproven: the modules that turn encoded
photographs into correspondences exist, agree with each other end to end, and
the emitter page now **calls them on photographs an operator hands in** — but no
real photograph has been through them. Phase 5 is measured rather than built. So
an operator can put the sequence on a real sphere and now get a number back
saying what the capture was worth — but not a pose, not a before-and-after, and
there is still no way to install a calibration. Phase 4 has begun at the honest
end — the export now says which of the files it overwrites it could put back,
and refuses to call one of five a restore point.** This is a plan, written because the question "what would an
operator actually do?" had no answer anywhere in the repository — not in code,
not in a document — while the simulator implied one.

What existed before this plan was a proof that the arithmetic works: the page
photographs a simulated sphere with structured light, fits a rig to the
photographs, and recovers a bumped installation to a fraction of a millimetre.
Every camera in that sentence is simulated. Phase 1 has since given the sequence
a way out to a real projector, but nothing accepts a real photograph back into
the solver, and `validation/` — the one place real photographs appear — says in
its own header that they are **not read by any critic**, plausibility only.

`docs/VISIT.md` is the closest thing to a field procedure and it is a different
activity: it measures an installation to check the model, and contains no
structured-light capture at all.

---

## The end goal

> An operator who has never read this repository walks up to their sphere with a
> CALIBRATED camera and a tripod, and an hour later the alignment is measurably
> better than it was — having installed nothing, seen the improvement before
> committing it, and with one obvious way to put everything back.

Three clauses of that are load-bearing and each kills adoption on its own:

- **installed nothing** — a science-centre display machine is locked down, and
  the person who can approve an installer is not the person standing at the
  sphere on a Tuesday;
- **seen the improvement before committing** — nobody overwrites a working
  installation's geometry on a promise;
- **one obvious way to put everything back** — the first question an operator
  asks about any calibration tool is what happens when it makes things worse.

**Calibrated** is not decoration in that sentence. `SolverCameraInput.intrinsics`
is an input — focal lengths, principal point and four distortion terms, described
in its own docblock as "a calibration they already have" — so a camera nobody has
calibrated cannot be handed to the solver at all. Review caught this missing from
both documents, and it is the one prerequisite on the operator's side that no
phase below removes: Phase 5 can set a camera's exposure over a tether, but
nothing here derives its intrinsics for it.

**What that reduces to in practice, and the target the phases are measured
against:** warm the projectors, darken the room, put a locked camera on a tripod,
press start three times, and say yes or no to a before-and-after. Four standing
rules, three setups and two moves. Everything else in `docs/CALIBRATE.md` today is
scaffolding for software that does not exist yet, and Part 6 of that card names
which phase deletes which rule — so the card getting shorter is the measure of
this plan working.

Two tripod moves is not a floor either. Once frames identify themselves (Phase 2)
a second and third camera cost mostly hardware, and three cameras shooting the
same sequence is one pass with no moves at all — hardware traded for time.

Not, however, three anonymous folders. Review caught an overstatement here: each
camera is a separate `SolverCameraInput` with **its own** intrinsics and its own
rough pose, so a folder has to stay associated with the camera that produced it.
Phase 2 removes the need to know which FRAME a photograph is; it does not remove
the need to know which CAMERA took it.

## Why friction is the organising principle rather than accuracy

The accuracy is already better than the alternative. PARAMETERS.md §7 wants
2 mm; Experiment 1's best measured cell anywhere is 2.79 mm, and a phone on a
tripod reaches 4.61 mm. Today that judgement is made **by eye, with no number at
all**, so 4.61 mm with a number beside it is a large improvement over the status
quo even though it misses the gate.

So the binding constraint on this being useful is not another decimal place. It
is that no operator can run it. Every phase below is ordered by how much friction
it removes, not by how interesting it is.

---

## The friction inventory

Ranked by how likely each is to end the attempt. This ranking is the argument for
the phase order, so it is stated before the phases rather than implied by them.

| # | Friction | Why it is fatal | Addressed in |
| --- | --- | --- | --- |
| 1 | Installing software | Locked-down machine, absent approver, wrong OS | Phase 1 — **landed** |
| 2 | Getting patterns onto the projectors | Structured light is projector-raster-space; SOS content is sphere-space, so the ordinary content path cannot carry it | Phase 1 — **landed** |
| 3 | Knowing which pattern each photo shows | The one genuinely unsolved problem here | Phase 2 — **measured, not settled** |
| 4 | Knowing where to stand and what to set | "Three positions" is measured; *which* three is not written down anywhere | Phase 0 |
| 5 | Getting photographs to the solver | Hundreds of files, and the solver has never seen a real one | Phase 3 — **reachable, unproven** |
| 6 | Trusting the result | A number with no before/after is a claim, not evidence | Phase 4 |
| 7 | Installing the result | Overwriting live geometry with no undo | Phase 4 |
| 8 | Understanding a failure | "It didn't converge" sends an operator home | every phase |

Friction 3 is the crux and is worth stating plainly: **something has to know that
pattern *N* was on the sphere when the shutter opened.** Everything else on this
list is work; that one is a design problem with no settled answer.

It is now a *smaller* problem with a measured boundary rather than an open one.
`docs/EXPERIMENT-8.md` scores the two cheap mechanisms and finds they remove most
of the exposure and leave one case — see Phase 2 — so the rule this friction
forces on an operator softens from *never delete a frame* to *a spoiled frame
costs that projector's run*. The remaining case still needs a real sphere.

---

## The shape of the capture, in numbers

So the phases below are costing something real rather than a guess.

At the page's own settings — `grayBits: 6`, `phaseSteps: 4`, two axes, plus
explicit white and black — `planFrames` emits **34 frames per projector per
camera position**:

| kind | count | why |
| --- | --- | --- |
| white, black | 2 | the references every later frame is read against |
| Gray planes | 12 | 6 bits × 2 axes; addresses 64 strips |
| Gray complements | 12 | the bit is the SIGN of the difference, so albedo and room light cancel |
| phase steps | 8 | 4 × 2 axes; sub-strip position |

For a four-projector rig at the measured three positions that is
**136 exposures per position, 408 in total**. At one frame per second that is
about two and a half minutes of shooting per position — the capture is not the
expensive part. **Moving the tripod and knowing which photo is which is.**

Two measured facts shape the procedure more than any of the above:

- **A tripod is not optional.** The same phone sensor reaches 4.61 mm on a tripod
  and 380–410 mm handheld, and handheld does not improve with resolution or with
  more photographs — shake is a *bias*, and no sensor fixes a bias.
- **Buying a better camera stops helping around 1280×960.** 320→640→1280 roughly
  halves the error each time; 2560×1920 measured *worse* than 1280×960.

---

## Phase 0 — Write the procedure down. No code. **LANDED**

`docs/CALIBRATE.md` — a numbered field card for calibrating, in the register
`docs/VISIT.md` already uses: what to bring, where to stand, what to set on the
camera, what to do at each position, what "good" looks like, and what it cannot
tell you yet.

This comes first because it is the cheapest way to find out what is missing, and
because it is the deliverable that is useful even if every later phase is
cancelled — an operator with a written procedure and a manual shutter can do this
today, slowly, if the pattern frames exist as files.

**It must state its own gaps rather than paper over them.** Where the procedure
says "the software will tell you which photo is which", and Phase 2 has not
landed, it says so.

**Done when** somebody who has not read this repository can follow it end to end
on paper and point at the step where they would get stuck.

**What writing it changed.** Two things the plan had not noticed. The projectors
have to be warmed for twenty minutes first — A-23 makes that a precondition, and
it binds harder here than on the photometric sequence, because a capture is
hundreds of frames that have to agree with each other and a lamp still climbing
changes the thing being measured *between* the two frames that are supposed to
cancel. And the friction this procedure does not have was missing from the card
until it was written down: **the operator never measures where they stood.**
Distance and aim are recovered from the photographs, so nobody needs a tape
measure.

That was then overstated into "camera poses are outputs, not inputs", which review
caught and which is false. `SolverCameraInput` takes a pose, and its docblock says
what the pose must be right about: which side of the sphere the camera was on —
not the distance, which the bootstrap corrects. So the operator does have one
thing to record, and it costs nothing if done while the tape is going down:
roughly where each position was. The card now says so; the error is noted here
because a plan that quietly drops a solver input is worse than one that never
mentioned it.

## Phase 1 — Put the patterns on the sphere, with no install. **LANDED**

`packages/web/emit.html`, published at `/emit/` and served locally at
`/emit.html` by `npm run app`. A page that fills the display machine's
framebuffer and plays the sequence into each projector's own raster. A browser is
the one piece of software already on every machine, which removes friction 1
outright — the operator opens a URL.

The mechanism was already proven in this repository: the developer harness draws
one WebGL2 context as five viewports, four of them the projector rasters as
quadrants of the single framebuffer SOS drives (`SOS_QUADRANT_VIEWPORTS`). Phase 1
is that, full-screen, with `compileFrame`'s output instead of a room render.

**This cannot go through the sphere-content path**, and the reason is the same
one that stopped the patterns being a content chip on the page: content is
indexed by position on the sphere, while a structured-light frame is a function of
the *projector's raster coordinate*. It has to address the raster directly.

**Not hard-coded to four.** The quadrant layout is an SOS fact, not a general one.
The page takes the projector count and the output mapping from the rig it is
given — see "Shape and projector count" below.

**Done when** a projector shows frame *N* of the sequence, full raster, on
command, for a rig the page was told about rather than one it assumed. It does,
and the arithmetic behind it — placement, order, and whether the window can
carry the pattern — is `packages/web/src/emit.ts`, tested in Node against the
conventions rather than against itself.

**What building it changed.** Four things, three of them corrections.

- **The viewport origin is not the canvas origin, and getting that wrong is
  silent.** conventions.ts §V normalizes `Viewport` with its origin at
  BOTTOM-left, matching the SOS config; a 2-D canvas has it at top-left. So slot
  0 — `{0, 0, 0.5, 0.5}`, which is P1, the projector nearest the SOS computer —
  is the LOWER half of the framebuffer, and the first draft of `viewportPixels`
  passed `y` straight through and put it in the upper one. Nothing about the
  picture says so: the pattern still looks right, the operator still photographs
  it, and every frame is filed under the wrong projector. The harness never hit
  this because GL's viewport origin is bottom-left too and the two conventions
  agree there.
- **Above four projectors the page refuses rather than guesses.** The three caps
  this plan already recorded (8 in the app shader, 4 in the harness, 4 in the SOS
  config format) turn into a decision as soon as something has to address a real
  output: nothing documents where a fifth raster lives in a framebuffer, because
  that is a property of a display pipeline nobody here has seen. A tool that
  guessed would light one projector under another's name.
- **Whether the window IS the framebuffer is measurable, and has to be shown.**
  An operator cannot see by eye that display scaling is on or that the window is
  not quite full-screen, and either makes the browser resample every frame — so
  the Gray edges land off the projector's own pixel grid and the calibration
  measures that displacement along with the optics. The page states the quadrant
  size against the raster it was told about, and refuses outright when the finest
  strip falls under two pixels, because at that point one fringe period is under
  four samples and the phase steps stop being sinusoids before they leave the
  machine.
- **Everything the page draws is on the sphere.** A panel, a cursor, a focus
  ring — all of it is light on the ball while the shutter is open. That forced an
  explicit ARMED state rather than an idle timeout a bumped mouse can undo, and
  it means the end-of-sequence signal has to be something an operator with a
  blank screen can perceive: the room going dark.

**What it deliberately does not do:** record what it emitted. Friction 3 is
Phase 2's to settle **by measurement between three candidate mechanisms**, and a
manifest format invented here would pre-empt that measurement with a guess that
everything downstream then rested on. The page shows the plan it is playing and
counts the steps; turning that into an index a decoder can trust is the next
phase and is named as such on the page itself.

## Phase 2 — Make every photograph say which frame it is. **MEASURED, NOT SETTLED**

The crux, and the phase that decides whether this is adoptable. If the software
can work out which pattern a photograph shows, **tethering leaves the critical
path** — the operator shoots however they like and drops the files in. If it
cannot, every operator needs a camera SDK working on their machine, and most will
stop there.

Three candidate mechanisms. **This phase picks by measurement, not by argument**
— the failure mode of choosing on plausibility is a capture that works in a dark
room in one building and not in another:

1. **Ordering alone.** The frames are shot in order, so the order is the index.
   Cheap and needs nothing; breaks on a dropped or duplicated frame, and gives no
   way to detect that it broke. **Built** — `indexByOrder`, as the baseline.
2. **Structural bookends.** White and black open each sequence and are trivially
   separable from every patterned frame, so software can find sequence boundaries
   and check the count between them. A black frame inserted between projectors
   segments the whole capture. Cheap, self-checking, and still ordering-dependent
   *within* a run. **Built** — `indexByBookends`.
3. **A frame index projected into the frame itself.** Fully self-describing and
   robust to any drop — and it spends raster area, and there is no single region
   of a sphere every camera position can see, so the marker has to be repeated or
   placed per projector. **Not built, and the measurement below is the argument
   for why not yet.**

**The measurement that decides it:** capture a real sequence with deliberate
drops and duplicates, and score each mechanism on how often it recovers the right
indexing and, more importantly, how often it *notices* that it has not. A
mechanism that silently mis-indexes is worse than one that refuses — a
mis-indexed Gray plane is a confidently wrong calibration.

`docs/EXPERIMENT-8.md` is that measurement, over 10 000 faulty captures:

<!-- generated: experiment-8-headline-operator-path -->
| mechanism | captures silently wrong | runs offered | of those, mis-indexed | mis-indexed per run captured |
| --- | --- | --- | --- | --- |
| ordering alone | 4000 / 10000 (40.0%) | 16000 | 10688 (66.8%) | 26.7% of 40000 |
| structural bookends | 603 / 10000 (6.0%) | 23600 | 1367 (5.8%) | 3.4% of 40000 |
<!-- /generated -->

**The run columns are the ones to read.** The share of captures that come back
without a complaint understates the bookends' exposure by a factor of three,
because a capture they refuse can still contain a run they got wrong and
offered — `ok: false` means some run was rejected, not that the rest are sound.
The honest unit is the projector run, since that is what goes into a bundle
adjustment, and there are two rates on it: of the runs a mechanism hands back,
how many are wrong (what a caller experiences), and wrong runs per run the
capture contained (what a session costs). Ordering scores far worse on the first
because on a faulty capture it offers runs **only where it noticed nothing**.

**What that settles.** The bookends are worth having and are not sufficient. They
cost one number read off each photograph and they never once offered a wrong run
on any capture that could not contain a cancelling pair — 8 000 trials of clean,
one drop, two drops and one duplicate. Their blind spot is exactly one case: a
drop and a duplicate that cancel *inside one run*, both landing on patterned
frames, where the count still adds up and every frame is still a patterned frame.
A lit-pixel fraction cannot tell one Gray plane from another, and that is the same
property that makes the white and black references separable in the first place.

**What it does not settle**, and what a real sphere is now needed for:

- **Whether the references stay separable in a room.** Classification is exact by
  construction in that experiment — it renders nothing — so its numbers are an
  **ideal-classification baseline**, not an upper bound: exact classification
  bounds recoverability from above, but a misread reference in a real room can
  either break a run's structure into an extra refusal or leave it intact and
  raise the silent rate, and neither direction is established.
  `indexByBookends` refuses below a stated margin rather than segmenting noise,
  and what that margin costs on real images is measured by nothing in this
  repository. §5's ambient term spans 1%–15% and a sphere that fills too little
  of the frame dilutes every reference toward the middle.
- **Whether mechanism 3 is worth its cost.** It obviously closes the blind spot —
  it is the only candidate that tells patterned frames apart from each other. The
  question is whether its photometric risk is smaller than the bookends' residual
  — 5.8% of the runs they offer, 3.4% of the runs a session contains — and that
  cannot be answered from a simulator. A cheaper candidate is
  untested and would close the same hole without spending raster area: a per-frame
  fingerprint asking whether a Gray plane and its neighbour are still complements.

**Done when** a folder of photographs, shot without tethering, is turned into a
correctly indexed capture, or refused with a reason. **Not yet** — the blind spot
returns a wrong capture rather than a refusal, and until it is closed or measured
on a real sphere this phase stays open.

## Phase 3 — Let the solver see a real photograph. **REACHABLE; STILL NO REAL PHOTOGRAPH**

Every image the bundle adjustment has ever been given was rendered by this
project. Real ones differ in ways that will not all be anticipated: sensor noise,
a non-linear transfer, clipping, dust, a visitor walking through, and a room that
is not as dark as the operator thinks.

The decoder is already built for most of this and says so — it reads bits as the
*sign* of a difference specifically so unmeasured albedo, ambient and cosine
falloff cancel, and it works in linear light because a gamma-encoded sinusoid
biases the phase estimate. Phase 3 is the plumbing plus the honesty:

- decode from real images, with the transfer stated rather than assumed;
- **report what the capture was worth before reporting a pose** — how many
  correspondences survived, from how many pairs, and which cameras contributed
  nothing. A solve on a capture nothing reached currently returns `converged:
  true` with the untouched bootstrap's own error presented as a result, and that
  guard exists in the pipeline because it happened.

**Done when** a real capture produces either a pose with its correspondence count
beside it, or a refusal naming what was wrong with the photographs.

### What landed

Three modules in `packages/solver`, all pure and Node-testable:

- **`ingest.ts`** — camera integers into linear light. The transfer is a required
  argument with no default, so a caller who does not know what their files are
  encoded with gets a compile error rather than a plausible-looking calibration.
  sRGB is named as a curve rather than fitted as a power law, because its toe is
  linear below 0.04045 and that is precisely where the black reference lives — a
  pure 2.2 misplaces the frame every other frame is measured against.
- **`assemble.ts`** — the piece that was actually missing. Phase 2 works out which
  frame each photograph is, `decodeCapture` reads a `PatternCapture`, and nothing
  turned one into the other: until now the only thing that ever built one was the
  bench, which knows the answer because it rendered the frames itself.
- **`worth.ts`** — the pipeline's zero-correspondence guard, generalised from one
  refusal into a report. It names the dominant rejection bucket in an operator's
  words, which is most of the distance between "it didn't converge" and an
  answer, and it refuses on two grounds rather than one.

**The second refusal is measured rather than asserted.** Fewer than two
contributing cameras is not a poor calibration but a degenerate one — a single
view cannot separate a projector's distance from its field of view, and
`docs/EXPERIMENT-1.md` puts one camera at 17 489.84 mm against 41.82 mm for two.
Everything else is reported beside the pose rather than used to withhold it,
because what a thin capture costs on a real sphere is unmeasured and a threshold
invented here would become the thing the pipeline rested on.

**And something now calls it.** The status line above used to end *"nothing in
this repository calls them — a test does"*, which was the honest description of
three modules that worked and could not be reached. The emitter page now has a
reader: hand it the plan it wrote and one projector's run of photographs, and it
runs `linearise` -> `assembleCapture` -> `decodeCapture` -> `captureWorth` and
reports what the capture was worth.

**The plan travels with the photographs**, which is the part that makes the
reader trustworthy rather than merely present. `assembleCapture` needs
`grayBits`, `phaseSteps`, `phasePeriodStrides` and the raster, and every one of
them decodes *wrong* rather than failing when it is wrong — the `phaseSteps`
case being the sharpest, where a four-step run read as three solves 0/90/180
degrees as 0/120/240. Since Phase 1 the emitter page had been telling operators
*"write the plan down… nothing yet records it for you"*, which is a real hazard
handed over as homework. It now writes `capture-plan.json`, and the reader
refuses a folder without one rather than assuming the defaults.

`packages/web/src/manifest.ts` is also the only place in the repository where
the emitter's frame order and the decoder's expectations can be checked against
each other: `boundary-lint` lets `solver` reach only `calibration`, so
`assembleCapture` can never see `planFrames`, and no test inside `solver` can
notice if the two drift apart. `packages/web/test/readback.test.ts` drives that
join directly.

**The chain runs end to end**, in `packages/solver/test/realphotos.test.ts`:
8-bit sRGB integers, through the transfer, through the assembler, through the
decoder, to correspondences that name the projector pixels that produced them.
A useful by-product for an operator choosing a file format: in that fixture —
noiseless, flat albedo, one camera pixel per projector pixel, so quantisation is
the only error present — **8-bit sRGB holds the decoded coordinate inside a
hundredth of a projector pixel**, and 16-bit inside a thousandth. Against §7's
2 mm on a 1.7 m sphere, the file format is not the term that matters. Shooting
JPEG does not give up the calibration.

### Why it is still UNPROVEN and not LANDED

**No real photograph has been through it.** That was true when nothing called
these modules and it is still true now that something does — a reader an
operator can reach is not a capture an operator has shot. The fixture is
synthetic: flat albedo, constant ambient, no sensor noise, no limb, no dust,
nobody walking through, and a camera whose pixels map one-to-one onto the
projector's. What it
establishes is that the three stages agree with each other and with `decode.ts`'s
normative pattern order — which is the part that was missing and the part a real
capture cannot be debugged without. It establishes nothing about a room.

**And it stops short of a pose, deliberately.** The done-when asks for *"a pose
with its correspondence count beside it, or a refusal naming what was wrong with
the photographs"*, and this phase's own text orders those two: *report what the
capture was worth before reporting a pose*. The second half is built. The first
needs each camera's intrinsics and a rough pose, which the reader does not have
— and intrinsics are the one operator-side prerequisite the end goal says no
phase here removes. Inventing them to reach a number would make that number the
thing somebody trusted.

**Three things the reader does not do**, each named rather than left to be
discovered:

- **It does not index the photographs.** The order files arrive in is taken as
  the order they were shot in. Phase 2 built mechanisms for establishing that
  from the pictures themselves and they are not wired in here, because a bad
  decode should say which of the two stages produced it.
- **It reads one projector run at a time.** A whole capture is twelve of them
  and the operator drives them one by one.
- **The browser gives it 8-bit pixels** whatever the file held, because
  `createImageBitmap` onto a canvas is how a page gets at a JPEG at all. The
  measurement above is what makes that survivable rather than an assumption.

The done-when says *a real capture*, and there has not been one. This phase stays
open until there is.

## Phase 4 — Show the improvement, then let it be undone. **STARTED: THE GAP IS NAMED, NOT CLOSED**

Frictions 6 and 7, and they are one phase because they are one conversation with
the operator: *here is what changes, here is how to change it back.*

- **Before and after, on their own sphere**, using the comparison the page
  already builds for the simulated case — overlay, blink, side by side.
  *Not built, and blocked by Phase 3: this needs a calibration from real
  photographs, and nothing reads a folder yet.*
- **The files, written the way the page already writes them**: Bourke
  warp-and-blend per projector, SOS alignment files, and the operator's own
  `sos_stream_control.config` patched rather than rewritten, so every setting the
  tool does not understand survives untouched. *Landed before this phase —
  `formatSosConfig` is a surgical edit of the file it was given.*
- **A restore point taken before anything is written**, and a one-step way back.
  Not a documented manual procedure — an action. *The plan is built and the
  archive carries it; the action is not.*

### What the first pass found

The archive could only ever have put back one of the files it installs, and
nothing said so.

The config is **patched**, so the page was handed the original and still holds
every byte. The warp meshes and alignment files are **generated**, so the page
has never seen whatever sits at those paths on the sphere. One of five.

That asymmetry is not a missing feature, it is a trap, and the difference
matters for what to build. The failure is not an operator who finds restore
unavailable — it is one who believes there is a way back, overwrites an
alignment they spent a day on, and finds out afterwards. So `planRestore`
refuses to call a partial cover a restore point at all, and the archive's
`restore/MANIFEST.txt` leads with what it cannot put back rather than listing
it under the part it can.

The honest consequence: **today the refusal always fires**, because the page is
never given the files it would overwrite. That is the next piece of work and it
is small — the page already has a picker for the config, and the same treatment
for the current warp and alignment files turns the refusal into a green light.
Until it exists the refusal says so, and tells an operator to copy those files
by hand rather than offering them a button that is not there.

Review also caught the guarantee being wider than the code: the config reached
the page through `File.text()`, which is a UTF-8 decode, so a config carrying a
byte-order mark would have been restored three bytes shorter and still valid
JSON. Originals are now held and archived as **bytes**.

**Done when** an operator can install a calibration, dislike it, and be back to
exactly the previous state in one step. **Not met**: the plan is computed and
carried, the copies are not complete, and putting a file back is still the
operator copying it by hand.

## Phase 5 — Tethering, as an accelerator and not a dependency. **MEASURED FIRST; THE CASE FOR AN SDK DID NOT SURVIVE IT**

With Phase 2 landed this is a convenience: the laptop advances the pattern and
trips the shutter, and 408 exposures happen without anybody touching the camera.
`decode.ts` already imagines this operator ("standing in a dark room with a
tethered camera"), and `docs/VISIT.md` budgets 40 minutes of tethered shooting
for the ground-truth visit, so tethering is already this project's assumed
modality for serious work.

It is deliberately last. Camera SDKs are per-vendor, per-platform and hostile,
and if this phase is on the critical path then friction 1 comes back in its worst
form — an install, on a locked machine, that only works for some cameras.

### This was the only phase with no Done-when, so it got a measurement instead

`docs/EXPERIMENT-9.md` asks what the open loop actually costs. The emitter
advances on a timer; the camera fires on its own clock; neither reads the other,
so a photograph can be taken while the projector is **changing**. The count is
still right and every frame is still present, so Phase 2's bookends see a
healthy capture — a second way into the blind spot EXPERIMENT-8 measured,
reached without anybody deleting a file.

**The first version of that experiment got the answer wrong, and the correction
is the finding.** It swept clock drift, found almost nothing, and concluded that
tethering was unjustified. Review found that the start phase — where in a dwell
the first shutter lands — was a constant buried in the model, drawn from the
middle half of the dwell. That excluded every boundary-adjacent start, which is
the risk in question, so the headline was a property of the sampling rule.

**A second round found the same mistake one level up.** The model ran all 408
frames as a single sequence, when the emitter plans 136 for one camera position
and stops — the operator moves the tripod and starts it again, drawing a fresh
phase. Three positions is three independent chances to begin in the wrong place,
so the capture-level risk is `1 − (1 − exposure/dwell)³` and the first number
published here was roughly half what it should have been.

Swept instead of assumed, at the loosest crystal and a 1/4 s exposure:

<!-- generated: experiment-9-phase-operator-path -->
| first shutter | 0.2 s dwell | 0.5 s dwell | 1 s dwell | 2 s dwell | 4 s dwell |
| --- | --- | --- | --- | --- | --- |
| aimed | — | 1767 (88.3%) | 116 (5.8%) | 0 (0.0%) | 0 (0.0%) |
| uniform | — | 1798 (89.9%) | 1198 (59.9%) | 728 (36.4%) | 468 (23.4%) |
| on-tick | — | 1830 (91.5%) | 9 (0.5%) | 13 (0.7%) | 20 (1.0%) |
<!-- /generated -->

Same clocks, same dwell, same exposure — only where the first shot landed.

**Drift is negligible**; that survives, and the three-position correction
strengthens it because the accumulation restarts at each tripod move. At the
default dwell one position accumulates ~27 ms against margins of 750 ms and
1000 ms either side of a mid-dwell shot.

**The start phase is the gamble, and it is taken three times.** A shot opening
at phase `p` straddles when `p > dwell − exposure`, so a start with no procedure
behind it straddles its first frame with probability `exposure / dwell` — 12.5%
at the page's defaults — and nothing about the clocks improves that. Compounded
over three camera positions that is 33.0% of captures, against 36.4% measured.
Four in five of those lose a whole position, every frame of it, while the other
two positions may be perfect.

**The page's tick already does real work.** `emit.ts` plays its tone AT the
step, so a shutter tripped on it opens a reaction time later, in the roomiest
part of the dwell. That was never documented as load-bearing and the field card
does not mention it.

### What that does to this phase

It does not remove the phase's justification, which is what the first pass
claimed. It **relocates** it: what a tether buys is the removal of the
start-phase gamble, not clock accuracy. And it puts three cheaper interventions
in front of it — telling an operator to shoot on the tick, saying what a short
dwell costs against their exposure, and discouraging a hand-pressed remote.

**Done when** — the clause this phase never had — an operator cannot silently
shoot a capture whose first shutter lands where the pattern is changing. A
tether satisfies that; so, more cheaply, might the tick plus a warning, and that
comparison is now possible where before there was no number at all.

**Not met.** The measurement is here and nothing has changed in the emitter.

---

## Shape and projector count

The arbitrary-shapes work and this plan meet in one place, and the good news is
that the capture does not care about shape at all.

**Structured light addresses projector rasters.** Nothing in `planFrames` or
`compileFrame` knows what the light lands on. The shape enters only in the solve,
where `BundleOptions.surface` already reaches every rung and `gaugeUnobserved`
already measures the model's own null space rather than assuming a sphere's. So
the operator path is shape-agnostic **by construction**, provided nothing in it
re-introduces a sphere assumption.

That gives the phases one standing rule: **take the surface and the rig from what
the operator supplies, never from a nominal.** A tool that quietly falls back to
the nominal sphere when it cannot parse a config is a tool that silently
calibrates the wrong body.

Projector count is less tidy, and the current state should be written down
because it is three different numbers:

| where | cap | what it means |
| --- | --- | --- |
| `packages/web/src/glsl.ts` | **8** | the app's display shader |
| `packages/harness/src/glsl.ts` | **4** | the developer harness |
| `packages/sim/src/sosconfig.ts` | **4** | the SOS config **file format** |

The last is the one with teeth: a rig of more than four projectors can be
simulated and solved, and **cannot be written back as an SOS config**. That is a
property of the format, not a gap in this project, and the operator path must say
so out loud rather than discover it at the write step. Bourke warp-and-blend
files are per projector and carry no such cap, so a larger rig still has a route
out — it is just not the SOS one.

The harness sitting at 4 while the app is at 8 is a discrepancy worth resolving on
its own, and it is not this plan's job.

---

## What would make this fail

Written now, while it is cheap to admit:

- **Phase 2 has no good answer.** Then every operator needs a tethered camera,
  adoption is limited to people who can install an SDK, and the honest response is
  to say so rather than to ship a fragile mechanism that mis-indexes quietly.
- **Real rooms are not dark enough.** Every measurement here was made in a
  simulated room with a stated ambient term. §5's `E_amb` spans 1% to 15% and is
  **unmeasured**; the complement trick is what makes that survivable, and how far
  it stretches has never been tested against a real room.
- **The display machine will not run a browser full-screen across the
  framebuffer.** Then Phase 1's no-install premise collapses and the patterns have
  to be delivered some other way.
- **Nobody wants it.** The status quo — aligning by eye, with no number — is
  entrenched and costs nothing to keep. A tool that is merely better does not
  displace a habit; one that takes an hour and shows its work might.

## What this plan does not include

- **A number for how accurate a real calibration will be.** Nobody has run one.
  Experiment 1's figures are simulated and are the best available prediction, not
  a result.
- **New gates.** §7's numbers are sphere theorems and nobody has measured a mesh
  installation; inventing a real-world gate before a real-world measurement is the
  one thing this project consistently refuses.
