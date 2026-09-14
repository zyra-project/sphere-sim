# Calibrating a real sphere — the operator path

**Status: Phase 0 landed — `docs/CALIBRATE.md`. Phases 1–5 are not built, so an
operator still cannot complete a calibration.** This is a plan, written because
the question "what would an operator actually do?" had no answer anywhere in the
repository — not in code, not in a document — while the simulator implied one.

What exists today is a proof that the arithmetic works: the page photographs a
simulated sphere with structured light, fits a rig to the photographs, and
recovers a bumped installation to a fraction of a millimetre. Every camera in
that sentence is simulated. Nothing drives a real projector, nothing accepts a
real photograph into the solver, and `validation/` — the one place real
photographs appear — says in its own header that they are **not read by any
critic**, plausibility only.

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
| 1 | Installing software | Locked-down machine, absent approver, wrong OS | Phase 1 |
| 2 | Getting patterns onto the projectors | Structured light is projector-raster-space; SOS content is sphere-space, so the ordinary content path cannot carry it | Phase 1 |
| 3 | Knowing which pattern each photo shows | The one genuinely unsolved problem here | Phase 2 |
| 4 | Knowing where to stand and what to set | "Three positions" is measured; *which* three is not written down anywhere | Phase 0 |
| 5 | Getting photographs to the solver | Hundreds of files, and the solver has never seen a real one | Phase 3 |
| 6 | Trusting the result | A number with no before/after is a claim, not evidence | Phase 4 |
| 7 | Installing the result | Overwriting live geometry with no undo | Phase 4 |
| 8 | Understanding a failure | "It didn't converge" sends an operator home | every phase |

Friction 3 is the crux and is worth stating plainly: **something has to know that
pattern *N* was on the sphere when the shutter opened.** Everything else on this
list is work; that one is a design problem with no settled answer.

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

## Phase 1 — Put the patterns on the sphere, with no install. **NOT STARTED**

A page that fills the display machine's framebuffer and plays the sequence into
each projector's own raster. A browser is the one piece of software already on
every machine, which removes friction 1 outright — the operator opens a URL.

The mechanism is already proven in this repository: the developer harness draws
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
command, for a rig the page was told about rather than one it assumed.

## Phase 2 — Make every photograph say which frame it is. **NOT STARTED**

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
   way to detect that it broke.
2. **Structural bookends.** White and black open each sequence and are trivially
   separable from every patterned frame, so software can find sequence boundaries
   and check the count between them. A black frame inserted between projectors
   segments the whole capture. Cheap, self-checking, and still ordering-dependent
   *within* a run.
3. **A frame index projected into the frame itself.** Fully self-describing and
   robust to any drop — and it spends raster area, and there is no single region
   of a sphere every camera position can see, so the marker has to be repeated or
   placed per projector.

**The measurement that decides it:** capture a real sequence with deliberate
drops and duplicates, and score each mechanism on how often it recovers the right
indexing and, more importantly, how often it *notices* that it has not. A
mechanism that silently mis-indexes is worse than one that refuses — a
mis-indexed Gray plane is a confidently wrong calibration.

**Done when** a folder of photographs, shot without tethering, is turned into a
correctly indexed capture, or refused with a reason.

## Phase 3 — Let the solver see a real photograph. **NOT STARTED**

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

## Phase 4 — Show the improvement, then let it be undone. **NOT STARTED**

Frictions 6 and 7, and they are one phase because they are one conversation with
the operator: *here is what changes, here is how to change it back.*

- **Before and after, on their own sphere**, using the comparison the page
  already builds for the simulated case — overlay, blink, side by side.
- **The files, written the way the page already writes them**: Bourke
  warp-and-blend per projector, SOS alignment files, and the operator's own
  `sos_stream_control.config` patched rather than rewritten, so every setting the
  tool does not understand survives untouched.
- **A restore point taken before anything is written**, and a one-step way back.
  Not a documented manual procedure — an action.

**Done when** an operator can install a calibration, dislike it, and be back to
exactly the previous state in one step.

## Phase 5 — Tethering, as an accelerator and not a dependency. **NOT STARTED**

With Phase 2 landed this is a convenience: the laptop advances the pattern and
trips the shutter, and 408 exposures happen without anybody touching the camera.
`decode.ts` already imagines this operator ("standing in a dark room with a
tethered camera"), and `docs/VISIT.md` budgets 40 minutes of tethered shooting
for the ground-truth visit, so tethering is already this project's assumed
modality for serious work.

It is deliberately last. Camera SDKs are per-vendor, per-platform and hostile,
and if this phase is on the critical path then friction 1 comes back in its worst
form — an install, on a locked machine, that only works for some cameras.

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
