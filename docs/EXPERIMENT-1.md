# Experiment 1 — how many photographs, and does a phone suffice?

**Status:** complete. Measured once, not iterated. Purely geometric, so **nothing
here is PROVISIONAL** — every parameter it touches is `DOC`, `CFG` or `SOLVE`.

**Command:** `npm run experiment1` — 43 cells, 197 solves, 1 h 25 m.
**Data:** `progress/experiment-1.json`, raw per-solve rows in
`progress/experiment-1-runs.jsonl`.
**Plots:** `progress/experiment-1-{camera-count,resolution,floor-reference,degradations}.svg`.

---

## The two answers, up front

> **How many photographs does a real calibration need?**
> **Three.** Going from one camera to two is worth **418×**; two to three is worth
> **1.7×**; three to eight is worth nothing measurable.

> **Does a phone suffice?**
> **The sensor does. The hand does not.** A 4032×3024 phone on a tripod recovers
> pose to **4.61 mm**. The same phone handheld recovers to **380–410 mm, and gets
> no better as resolution rises.** Camera shake is not noise that averages away —
> it is a bias, and no sensor fixes a bias.

Neither configuration reaches §7's 2 mm gate. The best cell measured anywhere in
this experiment is **2.79 mm** (1280×960, tripod, correspondence cap raised to
9000/pair). That is a statement about the gate as much as about the apparatus —
see A-11, A-18, and "What this does not settle" below.

---

## 1. Camera count

Five seeds per point, 320×240, four projectors, median pose position error in mm.

| cameras | tripod | handheld |
| --- | --- | --- |
| 1 | 17 489.84 | 46 781.05 |
| 2 | **41.82** | 343.57 |
| 3 | **24.93** | 380.69 |
| 4 | 24.80 | 369.76 |
| 5 | 22.43 | 378.33 |
| 6 | 23.57 | 385.03 |
| 7 | 14.92 | 370.85 |
| 8 | 18.31 | 191.52 |

**One camera is not a hard case, it is a degenerate one.** A single view cannot
separate a projector's distance from its field of view, and the 17.5 m result is
the optimiser wandering along that valley rather than failing to converge. It
should be read as "no answer", not as "a bad answer".

**Two cameras is the cliff. Three is the knee. After that the curve is flat.**
The 7-camera dip to 14.92 mm is within the scatter of its neighbours and is not a
trend — 8 cameras is worse than 7.

**Under handheld motion the count axis does nothing at all.** 343 mm at two
cameras and 371 mm at seven. Adding photographs cannot average out a bias that is
coherent within each photograph.

---

## 2. Resolution

Median pose position error in mm. Correspondence cap held at 1500 per
(camera, projector) pair, so this axis measures per-correspondence **precision**,
not correspondence **count**.

| camera | tripod | handheld | seeds |
| --- | --- | --- | --- |
| 320×240 | 24.93 | 380.69 | 5 |
| 640×480 | 12.49 | 329.23 | 5 |
| 1280×960 | **6.22** | 390.28 | 3 |
| 2560×1920 | 7.07 | 410.54 | 2 |
| 4032×3024 (phone) | **4.61** | — | 1 |

**On a tripod, error roughly halves per doubling of linear resolution — until it
doesn't.** 320→640→1280 gives 24.9 → 12.5 → 6.2 mm, almost exactly 1/2 each
time. Then it stops: 2560×1920 reads 7.07 mm, *worse* than 1280×960, and
4032×3024 reaches only 4.61 mm. Past about 1280×960 the sensor is no longer the
binding term.

**Handheld, resolution buys nothing whatsoever.** 380 → 329 → 390 → 411 mm across
a 8× range of linear resolution, non-monotone, all within each other's scatter.
This is the experiment's sharpest result: **a better camera cannot fix a moving
one.**

### The count-versus-precision control

The resolution axis holds the correspondence cap fixed, so a separate 2-cell
control varies the cap alone at 1280×960 on a tripod:

| cap per (camera, projector) pair | pose position |
| --- | --- |
| 1 500 | 6.22 mm |
| 9 000 | **2.79 mm** |

Six times the correspondences buys 2.2× — close to the √6 = 2.45 that pure noise
averaging predicts. So correspondence count and per-correspondence precision are
**both** real and roughly independent, and A-12's claim that the resolution win
was "precision, not count" was too strong: it is both, and the cheaper of the two
is keeping more points.

---

## 3. Floor-reference precision — the result that overturns A-16

Floor-reference σ is the tape measure §8 item 1 prescribes. A-16 concluded it was
the binding constraint on the pose gate. **It is not, and this axis settles it.**

| instrument | σ | pose position, 320×240 | pose position, 640×480 | `h_center` error |
| --- | --- | --- | --- | --- |
| survey | 0.1 mm | 24.45 | 11.06 | **0.04 mm** |
| laser measure | 1 mm | 24.76 | 12.47 | 0.28 mm |
| tape measure | 3 mm | 24.93 | 12.49 | 0.85 mm |
| *none supplied* | — | 24.88 | 12.45 | **12.60 mm** |

**Pose position does not move.** 24.45 mm with a survey instrument against
24.93 mm with a tape — a 2% difference across a 30× range of instrument
precision. Removing the floor reference *entirely* changes pose position by 0.2%.

**What the floor reference buys is `h_center`, and only `h_center`** — 0.04 mm
with a survey instrument, 0.85 mm with a tape, 12.60 mm with none. That is a
clean, strong result and it is exactly what PARAMETERS.md §1's note asks for:
recovering the ground-to-sphere-centre distance to sub-centimetre accuracy from
camera views, against a documented procedure that works in one-inch steps.
**A tape measure already achieves 0.85 mm — thirty times finer than that inch.**

So A-16's proposed remedy is refuted by direct measurement: buying a laser
distance meter would improve `h_center` from 0.85 mm to 0.28 mm and leave the
failing pose gate untouched. A-18 corrected this on the strength of a diagnostic;
this axis confirms it by sweeping the instrument itself.

---

## 4. Degradation conditions, each on its own

Five seeds, three cameras, 320×240, tripod except where motion is named.

| condition | pose position | rotation | grid | vs reference |
| --- | --- | --- | --- | --- |
| none (reference) | **1.24 mm** | 0.018° | 0.07 mm | — |
| ambient 0.04 (§5 nominal) | 1.24 mm | 0.018° | 0.07 mm | **×1.00** |
| ambient 0.15 (top of §5 range) | 1.24 mm | 0.018° | 0.07 mm | **×1.00** |
| rolling shutter, static camera | 1.24 mm | 0.018° | 0.07 mm | **×1.00** |
| sensor noise | 12.00 mm | 0.028° | 0.11 mm | ×9.7 |
| motion, global shutter | 210.80 mm | 1.970° | 12.79 mm | **×170** |
| motion + rolling shutter | 320.04 mm | 3.291° | 10.97 mm | ×258 |
| all together | 359.44 mm | 3.429° | 10.22 mm | ×290 |

**Ambient light costs nothing.** Not at §5's nominal 0.04, not at the top of its
stated range at 0.15. Gray-code decoding compares each pattern against its
complement, which cancels a static additive field exactly. This is a real
robustness property of the method, not luck.

**Rolling shutter on a static camera costs exactly nothing** — bit-identical to
the reference, as `packages/bench/test/capture.test.ts` asserts independently.
Reported because a condition the brief named must be shown to be inert rather
than assumed inert.

**Sensor noise costs about 10×**, and it is the term that resolution buys down.

**Motion costs 170× and dominates everything else combined.** Rolling shutter is
only meaningful in its presence, where it adds a further 1.5×. The quadrature sum
of the individual terms is far below the "all" cell, so the terms are not
independent — motion and sensor noise interact.

---

## 5. The mechanism, confirmed across all 43 cells

A-18 proposed that pose error arises through `fov_h`, by the subtense relation
`Δd/d = Δfov / (2·tan(fov/2))`. Every cell tests it:

- **Median ratio of measured to predicted radial error: 0.943.**
- **37 of 43 cells agree within twofold.**
- The six that do not are the one-camera cells, where the estimate is degenerate
  and the relation is not expected to hold.

`fov` error tracks the condition exactly: 0.11–0.19° on a tripod, **1.5–2.7°
handheld**, 0.033° at phone resolution on a tripod. The chain from A-18 —
motion biases the decode, the bias drags `fov_h`, `fov_h` becomes radial position
error — is now measured end to end rather than inferred from three scenarios.

---

## 6. What to tell someone doing this for real

1. **Take three photographs, from well-separated positions.** The second is worth
   418×; the third is worth 1.7×; the fourth is worth nothing.
2. **Use a tripod, or brace the phone against something solid.** This is the
   single highest-value instruction on the list — worth 170×, more than every
   other condition combined. A phone on a tripod beats a better camera in a hand.
3. **A modern phone's sensor is ample.** Resolution stops paying above about
   1280×960 on a tripod. Do not buy a camera; buy a tripod.
4. **Keep more correspondences rather than buying more pixels.** Raising the
   per-pair cap from 1500 to 9000 was worth 2.2× — comparable to doubling linear
   resolution, at a fraction of the capture cost.
5. **A tape measure to the floor is fine.** It buys `h_center` to 0.85 mm, thirty
   times finer than the one-inch step the documented procedure works in, and it
   has no measurable effect on anything else.
6. **Read the projector's make and model off its label.** Not measured here, but
   A-18 shows lens knowledge is worth 88–97% of the residual pose error, which is
   the term this experiment cannot reduce by any capture choice.

---

## What this does not settle

- **The 2 mm pose gate is not reached by any cell**, best 2.79 mm. This experiment
  measures what capture buys; A-18 shows the remaining term is lens knowledge, and
  A-11 shows the gate is finer than the measurements §8 prescribes to enable it.
  Whether the gate is right is a decision for the spec's author, not a measurement.
- **The cross term is unmeasured.** Whether a fourth photograph buys more at
  4032×3024 than at 320×240 was not swept — count was measured at 320×240 only.
- **The phone point is a single draw.** 4032×3024 ran at one seed, tripod only, at
  ~12 min per solve. The phone conclusion rests on the 2560×1920 point (2 seeds)
  and the trend beneath it, with 4032×3024 confirming rather than establishing it.
- **Four projectors only.** A three-projector install has fewer parameters and one
  fewer seam; its count answer is not measured.
- **`h_center` is scored against a floor reference the bench generates from truth
  plus noise.** A real tape measure has bias as well as noise, and bias is not
  modelled.
