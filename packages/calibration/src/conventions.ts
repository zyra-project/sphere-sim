// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Normative conventions for the boundary object.
 *
 * `sim/` and `solver/` share no code. They therefore have to agree on what the
 * numbers in a RigCalibration MEAN, and they have to agree by each implementing
 * this document independently. If one of them gets a sign, an axis order, or a
 * distortion direction wrong, the recovery error explodes and the bench catches
 * it. That failure mode is a feature: it is the only thing standing between us
 * and a simulator that scores its own assumptions.
 *
 * This module exports the conventions as text so reports can quote them
 * verbatim. It contains no executable mathematics.
 */

export const CONVENTIONS_VERSION = 'sphere-sim/conventions@3';

/**
 * Headroom around the sphere's silhouette in the raster's MINOR dimension, as a
 * fraction of the silhouette's own angular half-extent. conventions.ts §N.
 *
 * A literal, not a derivation: this package holds no mathematics. Both sides
 * read this number and each builds its own frustum from it.
 *
 * It exists because PARAMETERS.md §3.1 and docs/AMENDMENTS.md A-01 describe the
 * construction ("inscribe the silhouette in the minor dimension") without ever
 * pinning the headroom, and two independent implementations then picked 2% and
 * 0%. That undeclared 0.63-degree gap is docs/AMENDMENTS.md A-17 and A-19.
 */
export const NOMINAL_SILHOUETTE_MARGIN_FRAC = 0.02;

/** The four nominal azimuth slots, degrees. PARAMETERS.md §2. conventions.ts §N. */
export const NOMINAL_AZIMUTH_SLOTS_DEG: readonly number[] = [0, 90, 180, 270];

/**
 * Which of the four §2 slots an install of N projectors occupies, by default.
 * conventions.ts §N. Literal table, indexed by projector count.
 *
 * §2 says "2- and 3-projector installs are supported; quadrants go dark" and
 * never says WHICH quadrants. docs/AMENDMENTS.md A-06 settled N=2 (opposed
 * mounts) and A-19 settles N=3 the same way: a subset of the four 90-degree
 * slots, because "a quadrant goes dark" removes a projector from a standard
 * layout rather than respacing the ones that remain.
 */
export const NOMINAL_SLOTS_BY_COUNT: Readonly<Record<number, readonly number[]>> = {
  1: [0],
  2: [0, 2],
  3: [0, 1, 2],
  4: [0, 1, 2, 3],
};

export const CONVENTIONS_MD = `# RigCalibration conventions (${'conventions@3'})

Both the forward model and the solver must satisfy every clause here, each with
its own independent implementation. Nothing in this file may be imported as
executable mathematics by either side.

## §W — World frame

Right-handed. Origin at the sphere centre. \`+Z\` up. \`+X\` toward the canonical
prime meridian. \`+Y\` completes the triad. The floor plane is \`z = -h_center\`.
(PARAMETERS.md, Conventions.)

## §S — Sphere frame

Latitude \`lat\` in [-90, +90], longitude \`lon\` in (-180, +180].
\`(0 lat, 0 lon)\` lies on \`+X\`. Longitude increases toward \`+Y\`.

A surface point is
\`p = R * (cos(lat)cos(lon), cos(lat)sin(lon), sin(lat))\`.

The sphere's mechanical rotation \`rotationOffsetDeg\` maps texture longitude to
world longitude: \`lon_world = lon_texture + rotationOffsetDeg\`. Equirectangular
source imagery is centred on the prime meridian, so texture column 0 is
\`lon_texture = -180\` and the image spans a full 360 by 180 degrees.

## §R — Rotation

A projector's rotation is the intrinsic sequence yaw, then pitch, then roll:

\`R = Rz(yaw) * Ry(-pitch) * Rx(roll)\`

applied to a canonical camera frame whose optical axis is \`+X\`, whose right
vector is \`-Y\`, and whose up vector is \`+Z\`, all expressed in the world frame
before rotation. Positive \`pitch\` raises the optical axis toward \`+Z\`.
Positive \`roll\` rotates the projected image clockwise as seen from the lens
looking out along the optical axis.

A projector at azimuth \`phi\` aimed at the sphere centre therefore has
\`yaw = phi + 180\` and \`pitch = elevation_of_center_from_lens\`, where elevation
is signed and measured from the lens's own horizontal. A lens mounted above the
sphere centre looks down, so both its elevation and its pitch are negative.

(Revision note: this clause previously read \`pitch = -elevation\`, which
contradicted the definition two paragraphs above. Both models had independently
implemented \`pitch = asin(axis.z)\` from the definition and ignored the worked
consequence, so nothing was built against the wrong sign — but it was vacuous
only because PARAMETERS.md §1 and §2 put lens and equator at the same 2.1844 m,
and it would have bitten the moment a lens sat at any other height. See
docs/AMENDMENTS.md A-07.)

## §I — Interior orientation

The ideal (undistorted) pinhole maps a point in the projector's own frame with
optical-axis component \`a\` (forward), right component \`r\`, and up component
\`u\` to normalized image coordinates

\`x = r / a\`, \`y = u / a\`.

Focal lengths in pixels follow from the horizontal field of view:

\`fx = (resX / 2) / tan(fovHDeg / 2)\`, \`fy = fx * pixelAspect\`.

The principal point includes lens shift, which is expressed as a fraction of the
HALF-image dimension:

\`cx = resX / 2 + shiftH * resX / 2\`, \`cy = resY / 2 - shiftV * resY / 2\`.

Pixel coordinates have their origin at the TOP-LEFT of the projector's own
raster, \`u\` increasing right, \`v\` increasing DOWN. Pixel centres are at
half-integer coordinates: the first pixel's centre is (0.5, 0.5).

## §D — Distortion

Brown-Conrady, defined in the IDEAL -> DISTORTED direction. Given ideal
normalized \`(x, y)\` with \`r2 = x*x + y*y\`:

\`x_d = x * (1 + k1*r2 + k2*r2*r2) + 2*p1*x*y + p2*(r2 + 2*x*x)\`
\`y_d = y * (1 + k1*r2 + k2*r2*r2) + p1*(r2 + 2*y*y) + 2*p2*x*y\`

then \`u = cx + fx * x_d\`, \`v = cy - fy * y_d\`. Note the sign on \`v\`: image
\`y\` is up in normalized coordinates and down in pixel coordinates.

Consequences each side must handle on its own:

- The forward model goes pixel -> world ray, so it must INVERT this map. Any
  numerically sound inversion is acceptable; the boundary specifies the
  forward direction only.
- The solver goes world -> pixel, so it applies this map directly.
- Distortion is applied about the principal point INCLUDING lens shift, not
  about the raster centre.

## §C — The observing camera

The solver's input is camera images, so the two sides must agree on how a camera
maps the world to a pixel — and until this section existed, nothing governed that
agreement. It is stated here for the same reason as everything else in this file:
so each side can implement it independently.

A camera has a pose (§R, identical conventions and identical canonical frame as a
projector: optical axis \`+X\`, right \`-Y\`, up \`+Z\`) and intrinsics
\`{resX, resY, fx, fy, cx, cy, k1, k2, p1, p2}\` in pixels.

Imaging follows §I and §D exactly, with two differences from a projector:

- Focal lengths are given directly as \`fx\`, \`fy\` rather than derived from a
  field of view, because a camera is calibrated rather than specified.
- The principal point \`cx\`, \`cy\` is given directly in pixels rather than
  derived from a lens shift.

Everything else is shared with §I and §D: pixel origin top-left, \`v\` increasing
down, pixel centres at half-integer coordinates, distortion defined in the
IDEAL -> DISTORTED direction and applied about \`(cx, cy)\`.

A camera therefore runs §D in the direction OPPOSITE to a projector's. A
projector takes a pixel and emits a ray, so it must invert §D. A camera receives
a ray and records a pixel, so for the purpose of *rendering* an image the
simulator must invert §D as well, while the solver applies it forward when
predicting where a known surface point lands. Getting this backwards produces a
distortion error that is symmetric in image radius and therefore easy to mistake
for a focal-length error — check the residual scatter's radial signature.

Nothing about the camera is part of the recovered calibration: it is measurement
apparatus, not a property of the installation. It does not appear in
\`RigCalibration\`.

## §V — Viewports and the shared framebuffer

PARAMETERS.md §3.4: the deployment target is ONE framebuffer split into four
quadrant viewports, not four independent outputs. \`Viewport\` is normalized to
the framebuffer with its ORIGIN AT BOTTOM-LEFT, matching the SOS
\`projectorInfo(viewport)\` values \`{0,0,0.5,0.5 ...}\`. A projector's own raster
is \`resX by resY\`; the framebuffer is the union of the viewports, so four
1920x1080 projectors imply a 3840x2160 X screen.

## §N — Nominal rig construction

Both sides build "the rig PARAMETERS.md describes" — the forward model to have
something to perturb, the solver to have something to start from. They build it
from the same prose, independently, and they are *expected* to agree. Two
quantities in that construction are not stated anywhere in PARAMETERS.md, so
each implementation had to choose, and the choices silently diverged. They are
fixed here, as values, and each side still derives everything else on its own.

**§N.1 — Silhouette margin.** PARAMETERS.md §3.1 and docs/AMENDMENTS.md A-01
put the sphere's silhouette inscribed in the raster's MINOR dimension. A
silhouette inscribed with *zero* headroom puts the limb exactly on the raster
edge, where the limb test of §4.1 and the raster-bounds test disagree in the
last bit and coverage develops a ragged fringe. The headroom is therefore
**2% — \`marginFrac = 0.02\`**, exported as \`NOMINAL_SILHOUETTE_MARGIN_FRAC\`:
the minor dimension's half-angle covers \`(1 + 0.02)\` times the tangent of the
silhouette's angular radius \`asin(R / d_proj)\`. At 1920x1080, R = 0.8636 m and
d_proj = 5.18 m that is \`fovH = 34.0918\` degrees, against 33.4610 at zero
margin. The gap is 0.63 degrees and it is the whole of docs/AMENDMENTS.md A-17.

The margin is a property of the NOMINAL construction only. It is not a claim
about any real projector, and a caller holding a spec sheet passes the measured
field of view instead — PARAMETERS.md §3.1 classes \`T\` as CFG for exactly that
reason.

**§N.2 — Which slots go dark.** PARAMETERS.md §2 gives four azimuth slots,
\`0, 90, 180, 270\` degrees counterclockwise from P1, and says "2- and
3-projector installs are supported; quadrants go dark". It does not say which.
The reading taken here is the one §2's own sentence carries: a projector is
ABSENT from an otherwise standard four-slot rig, so the installed projectors
occupy a SUBSET of the four 90-degree slots and the ones that remain are not
respaced. So N=4 uses slots {0,1,2,3}, N=3 uses **{0, 1, 2}** — azimuths
0, 90, 180 — and N=2 uses **{0, 2}** — azimuths 0, 180, the opposed pair, which
is the only 2-projector arrangement that covers the sphere (docs/AMENDMENTS.md
A-06). \`NOMINAL_SLOTS_BY_COUNT\` states the table.

The rejected reading is equal spacing: 0, 120, 240 for N=3. It is a defensible
sentence in isolation and it is what one of the two implementations did, but it
respaces surviving mounts, it contradicts "quadrants go dark", and it puts a
30-degree azimuth error into a bootstrap that has no way to know about it.
Projector \`i\` keeps slot \`i\`'s viewport (§V) whichever slots are occupied.

Both readings are the *implementations'* choice recorded as a contract, not a
statement about the spec: PARAMETERS.md remains silent, and
docs/AMENDMENTS.md A-19 asks the author to settle both upstream.

## §B — Blend ramp

Let \`t\` in [0, 1] be the normalized position across a projector's blend region,
\`t = 0\` at the outer edge where this projector contributes nothing and
\`t = 1\` at the inner edge where it contributes fully. The unnormalized ramp is

- linear:     \`w = t\`
- cosine:     \`w = 0.5 - 0.5*cos(pi*t)\`
- smoothstep: \`w = t*t*(3 - 2*t)\`
- gaussian:   \`w = exp(-4.5*(1-t)^2)\` normalized so \`w(0)=0, w(1)=1\`

The ramp exponent \`rampGamma\` is applied to the WEIGHT, not to the signal:
\`w_final = w ^ rampGamma\`. Weights across all contributing projectors are then
normalized to sum to one wherever at least one projector contributes.

## §M — Polar mask

\`maskLoDeg\` is the latitude at which attenuation begins and \`maskHiDeg\` the
latitude at which it is total, both measured as ABSOLUTE latitude. Between them
the attenuation follows a cosine feather. With \`bottomOnly\` true the mask
applies only at negative latitudes, matching \`set bottommask 60,70\`.
PARAMETERS.md §4.4 flags the latitude interpretation as inferred, not published.

## §P — Photometry

Relative linear radiance per channel. \`1.0\` is a single projector's full output
in that channel at the centre of its own footprint, measured at the sphere
surface. Encoded signal \`V\` in [0,1] becomes emitted linear radiance

\`L = gain * ((1 - blackFloor) * V^gamma + blackFloor)\`

per channel. Summation across projectors, ambient addition, and every metric are
computed in linear light. Encoding happens only at the final viewer-camera step.
`;
