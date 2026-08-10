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

export const CONVENTIONS_VERSION = 'sphere-sim/conventions@2';

export const CONVENTIONS_MD = `# RigCalibration conventions (${'conventions@2'})

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
\`yaw = phi + 180\` and \`pitch = -elevation_of_center_from_lens\`.

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

## §V — Viewports and the shared framebuffer

PARAMETERS.md §3.4: the deployment target is ONE framebuffer split into four
quadrant viewports, not four independent outputs. \`Viewport\` is normalized to
the framebuffer with its ORIGIN AT BOTTOM-LEFT, matching the SOS
\`projectorInfo(viewport)\` values \`{0,0,0.5,0.5 ...}\`. A projector's own raster
is \`resX by resY\`; the framebuffer is the union of the viewports, so four
1920x1080 projectors imply a 3840x2160 X screen.

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
