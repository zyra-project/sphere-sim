# @sphere/calibration — the boundary object

This package is the **only** thing that crosses between `packages/sim` (the
forward model) and `packages/solver` (the inverse model).

It holds three things and nothing else:

1. **Types.** `ProjectorCalibration` and friends — pose, FOV, lens shift,
   distortion coefficients, per-channel transfer terms, viewport.
2. **Literal constants.** `PARAMETERS.md` transcribed as data, every entry
   carrying its provenance class and plausible range.
3. **Prose.** `conventions.ts` — the normative description of what every number
   means: axis order, rotation sequence, distortion direction, pixel-centre
   offsets, viewport origin, blend ramp definitions.

## Why there is no code here

`tools/boundary-lint.ts` fails CI if this package contains an arithmetic
operator, a `Math.*` call, or any callable declaration. That is not a style
preference. If a helper lived here — even something as innocent as
`applyDistortion()` — the solver would be inverting the simulator's own
arithmetic, and every recovery score the bench produced would be circular. The
simulator would be grading its own homework.

So the two sides each implement `conventions.ts` **from scratch**, and the only
thing they agree on is a JSON document. If either side gets a sign or an axis
order wrong, pose recovery error blows up and the bench catches it. That is the
intended failure mode, and it only works if this package stays inert.

Derived values are written longhand. `R` is `0.8636`, not `D_sphere / 2`, with
the derivation recorded in the note field.

## Schema stability

`RigCalibration.schema` is `sphere-sim/rig-calibration@2`. Bump it on any
incompatible shape change; both sides check it on load.
