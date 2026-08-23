/**
 * The simulated camera rig: render what a camera in the room photographs while
 * each structured-light pattern is displayed, then hand the frames to the
 * solver's decoder.
 *
 * ## Why images and not correspondences
 *
 * The bench could compute the correspondence `(camera pixel -> projector pixel)`
 * analytically and pass it straight to `solve()`. It must not. A correspondence
 * handed over that way is a statement in the bench's own arithmetic, and a
 * solver scored against it is being asked whether it can invert the scorer.
 * Rendering the patterns through `packages/sim`'s physics and making the solver
 * READ them puts the decoder, the modulation thresholds, the phase estimator and
 * the whole photometric path between the two models, which is where the honest
 * failure modes live. Every rejected pixel in `DecodeStats` is a pixel a real
 * capture would also have lost.
 *
 * ## What is modelled, and what is not
 *
 * Modelled: the projector's frustum, lens shift and distortion (via
 * `packages/sim`); the sphere; `cos(incidence)` and the inverse-square falloff
 * that PARAMETERS.md §3.3 shows is an 18% swing across one footprint; the
 * surface reflectance of §1; ambient irradiance per §5; the projector's black
 * floor per §3.2; photon shot noise and sensor read noise; ADC quantization and
 * saturation; camera lens distortion per conventions.ts §C; and handheld motion
 * against a rolling shutter.
 *
 * Not modelled, and each omission is a place a real capture is harder than this
 * one: projector depth of field (PARAMETERS.md §9 and §3.3 — focus is worst
 * exactly at the blend regions), inter-reflection off the room, the guard rail
 * and its shadow, and the projector's own pixel structure. The bench therefore
 * reports an optimistic decode. That is worth saying out loud in a document that
 * exists to be audited.
 *
 * One of those omissions is now switchable rather than absent: `roomSpill` puts
 * the light that MISSES the sphere onto the room and lets the pattern modulate
 * it. PARAMETERS.md §7 gates off-sphere flux at 52% and amendment A-03 measures
 * the floor on a 16:9 chip near 56%, so the wall behind the sphere is being
 * patterned in every real capture and an off-sphere pixel there is not a
 * constant. It is OFF by default and every published number was produced with it
 * off. See {@link RoomSpill}.
 *
 * ## One projector at a time
 *
 * Not a simplification — the capture protocol. `decode.ts` explains it:
 * PARAMETERS.md §4.2 puts overlap multiplicity at 2 in the seams, and two
 * projectors patterning at once would make the seam, the one region the whole
 * exercise exists to align, the one region that cannot be decoded.
 *
 * ## The blend ramp and the polar mask are OFF during capture
 *
 * Both are content compositing (conventions.ts §B, §M), and a calibration
 * pattern is not content. Ramping the pattern would attenuate exactly the seam
 * the solve most needs, and masking it would delete the polar overlap
 * PARAMETERS.md §1's note is about. A real operator running Grid Alignment
 * displays the pattern over the projector's whole raster for the same reason.
 */

import type { ChannelTriplet, RigCalibration } from '../../calibration/src/index.ts';
import { PARAMETER_TABLE } from '../../calibration/src/parameters.ts';
import type { RgbImage } from '../../sim/src/equirect.ts';
import { createImage } from '../../sim/src/equirect.ts';
import { raySphereIntersect } from '../../sim/src/geometry.ts';
import type { PreparedProjector, PreparedRig } from '../../sim/src/optics.ts';
import { prepareRig, worldToPixel } from '../../sim/src/optics.ts';
import type {
  Correspondence,
  DecodeOptions,
  DecodeStats,
  GraySequence,
  LinearImage,
  PatternCapture,
  PhaseSequence,
  SilhouetteOptions,
} from '../../solver/src/index.ts';
import { decodeCapture, segmentSphere } from '../../solver/src/index.ts';
import type {
  CameraPose,
  FrameClock,
  HandheldMotion,
  MotionState,
  SimulatedCamera,
} from './camera.ts';
import { canonicalRayTable, makeMotionState, poseAt, rotationOf, rowTimeSec } from './camera.ts';
import type { FrameSpec, PatternPlan } from './patterns.ts';
import {
  LUMINANCE_WEIGHTS,
  compileFrame,
  emittedRadianceForTarget,
  planFrames,
  strideFor,
} from './patterns.ts';
import type { BenchRng } from './random.ts';
import { makeBenchRng } from './random.ts';

// ---------------------------------------------------------------------------
// Sensor
// ---------------------------------------------------------------------------

/**
 * A photon-counting sensor, expressed in the radiance units of conventions.ts
 * §P so the decoder's thresholds keep their documented meaning.
 *
 * Shot noise is not optional and is not Gaussian-with-a-fixed-sigma. The photon
 * count in a pixel is Poisson, so its variance equals its mean: bright pixels
 * are noisier in absolute terms and quieter in relative ones. That is exactly
 * the structure a structured-light decode cares about, because the phase
 * estimate's uncertainty scales as `sigma_I / B` — noise over fringe amplitude —
 * and both terms move together with the surface's `cos(incidence)`. Modelling
 * the noise as a constant sigma would make grazing incidence look better than it
 * is and normal incidence look worse.
 *
 * `electronsPerUnitRadiance` folds the exposure and the sensor's conversion gain
 * into one number, which is what makes the buffers stay in §P units instead of
 * in ADU. It is the electron count a pixel collects from radiance 1.0 — one
 * projector's full output at the centre of its own footprint. 6000 e- is a
 * plausible full-well for a phone pixel exposed near the top of its range, and
 * it puts the noise at 0.9% of signal on a mid-grey fringe, which is the figure
 * the solver's own sensitivity table is quoted against.
 *
 * PARAMETERS.md gives no sensor figures at all — there is no §5 entry for a
 * camera — so all four numbers are class ASSUME in the spec's sense and are
 * echoed into `bench-results.json` rather than buried here.
 */
export interface SensorModel {
  electronsPerUnitRadiance: number;
  readNoiseElectrons: number;
  /** ADC bits over `[0, saturationRadiance]`, or null for no quantization. */
  quantizationBits: number | null;
  /** Radiance at which the pixel clips. */
  saturationRadiance: number;
}

export const DEFAULT_SENSOR: SensorModel = {
  electronsPerUnitRadiance: 6000,
  readNoiseElectrons: 3,
  quantizationBits: 12,
  saturationRadiance: 1.4,
};

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * The degradation conditions, each independently switchable.
 *
 * Experiment 1 needs them separable, so nothing here is bundled: a scenario can
 * turn on ambient without noise, noise without motion, or motion without a
 * rolling shutter. The three that PARAMETERS.md speaks to carry their section:
 * `ambient` is §5's `E_amb`, `reflectance` is §1's `rho_R,G,B`, `roomAlbedo` is
 * §5's `rho_room`. The sensor and the motion have no section, and that is
 * recorded rather than hidden.
 */
/**
 * The room the light that misses the sphere lands on.
 *
 * ## Why this exists
 *
 * With it `null` — the default, and how every published number was produced —
 * an off-sphere pixel is one constant, `ambient * lum(rho) * rho_room`, hoisted
 * above both the frame loop and the pixel loop. It is therefore FRAME-INVARIANT,
 * so `white - black` there is exactly zero plus two sensor draws, and the
 * decoder rejects it on modulation without ever being asked a hard question.
 *
 * A real capture is not like that. PARAMETERS.md §7 gates off-sphere flux at 52%
 * and amendment A-03 measures the floor on a 16:9 chip near 56%, so more than
 * half of every projector's light lands on the room — and what lands is the
 * structured-light pattern. Those pixels carry real modulation, decode to a real
 * projector coordinate, and are at the wrong depth. That is a failure mode
 * `minModulation` and the solver's robust loss have never been shown.
 *
 * ## The room, and what it assumes
 *
 * A closed cylinder about the sphere's own axis: a wall at `wallRadiusM`, the
 * floor at the sphere's `-h_center`, a ceiling `ceilingM` above it. That is the
 * shape the page already draws, and the shape a gallery holding a 5.36 m lens
 * ring is. Both numbers are class ASSUME — PARAMETERS.md describes a sphere and
 * a rig, not a building — and neither has been measured.
 *
 * A room point receives exactly what a sphere point receives: `cos(incidence)`
 * times the same inverse-square falloff against the same reference distance,
 * gated by the projector's raster and by whether the sphere stands between the
 * lens and the point, then scaled by §5's `rho_room`. The sphere's own shadow on
 * the wall therefore appears, unmodulated, which is a thing a real capture has
 * and a thing the decoder should have to cope with.
 *
 * Two things it still does not model. There is no second bounce: light reaches
 * the room and stops, so inter-reflection back onto the ball — the omission the
 * header names — is untouched. And the room takes the SPHERE's paint
 * reflectance scaled by `rho_room`, because that is the reflectance convention
 * the ambient background already uses and inventing a second one would make the
 * two backgrounds disagree about what a wall is.
 */
export interface RoomSpill {
  /** Cylindrical wall radius about the sphere's axis, metres. ASSUME. */
  wallRadiusM: number;
  /** Floor to ceiling, metres. ASSUME. */
  ceilingM: number;
}

/**
 * A gallery that holds the rig with room to walk round it.
 *
 * 6.0 m of wall radius puts the wall 0.64 m outside the §2 lens ring at 5.36 m,
 * which is about the tightest a room can be and still have the projectors hang
 * in it. 4.27 m is fourteen feet, the ceiling the Boulder install assumes and the
 * one the page's own room is drawn at. Both are ASSUME: nobody has measured a
 * gallery, and a tighter room means MORE spill, not less — so this default is
 * not a conservative one and should not be read as a bound.
 */
export const DEFAULT_ROOM_SPILL: RoomSpill = {
  // Read from the table rather than written here. These were literals in this
  // file with no row in PARAMETERS.md at all until the room stopped being
  // hypothetical, which meant two ASSUME constants drove experiment 4's headline
  // while the document that is supposed to account for every constant did not
  // know they existed. §5 carries them now and §8 item 19 collects them.
  wallRadiusM: PARAMETER_TABLE.r_wall.nominal,
  ceilingM: PARAMETER_TABLE.h_ceiling.nominal,
};

export interface CaptureConditions {
  /** `E_amb`, relative irradiance on the sphere. §5 nominal 0.04, range 0.01-0.15. */
  ambient: number;
  /** §1 `rho_R,G,B`. */
  reflectance: ChannelTriplet;
  /** §5 `rho_room`. Only used to shade the pixels that miss the sphere. */
  roomAlbedo: number;
  /** null renders a noiseless sensor — useful as a canary, not as a claim. */
  sensor: SensorModel | null;
  /** null holds the camera perfectly still; see camera.ts on why that matters. */
  handheld: HandheldMotion | null;
  clock: FrameClock;
  /**
   * PARAMETERS.md §4.3's usability threshold. Below `cos(incidence) = 0.2` the
   * spec says resolution smear exceeds 5x and the image becomes streaks; a
   * streaked fringe carries no phase. Points below it receive ambient only, so
   * the decoder rejects them on modulation exactly as it would in the room.
   */
  minIncidenceCos: number;
  /**
   * Where the light that misses the sphere lands. `null` — the default, and how
   * every published number was produced — leaves off-sphere pixels a constant.
   * See {@link RoomSpill}.
   */
  roomSpill: RoomSpill | null;
  /**
   * Segment the sphere out of the photograph before decoding, and options for it.
   *
   * Null is off, and off is what every published number was produced with. This
   * is the image-space counterpart to `RunOptions.segmentSphere`: that one asks
   * the NOMINAL rig whether a decoded ray reaches the ball and therefore depends
   * on the answer being solved for; this one asks the pixels and depends on
   * nothing.
   */
  segmentImage: Partial<SilhouetteOptions> | null;
}

export interface CaptureOptions {
  plan: PatternPlan;
  conditions: CaptureConditions;
  /** Everything random in the capture derives from this. */
  seed: number;
  decode: Partial<DecodeOptions>;
  /**
   * Render these (camera, projector) pairs' frames into {@link CaptureResult.previews}.
   *
   * A list rather than one pair, because "what did the operator actually
   * photograph" is a question about the whole set: one frame from one camera is
   * a thumbnail, and a frame from EACH camera is the evidence that the spread of
   * viewpoints is what makes the solve well conditioned. The bench asks for one;
   * the browser app asks for one per camera and shows them.
   */
  previewPairs: readonly { camera: number; projector: number }[];
  previewFrame: number;
}

export interface PairStats {
  camera: number;
  projector: number;
  considered: number;
  accepted: number;
}

export interface CaptureResult {
  correspondences: Correspondence[];
  stats: DecodeStats;
  perPair: PairStats[];
  framesRendered: number;
  /** Camera pixels traced through the geometry. The bench's dominant cost. */
  pixelsTraced: number;
  /** The LAST requested frame, for the artifact PNG. Null unless requested. */
  preview: RgbImage | null;
  /** Every requested frame, in (camera, projector) order. See `previewPairs`. */
  previews: PreviewFrame[];
  /**
   * What the silhouette detector did, per camera. Empty when image segmentation
   * is off. Reported rather than assumed: a detector that quietly selected the
   * floor would otherwise look exactly like one that worked.
   */
  silhouettes: SilhouetteReport[];
  /** Per-camera motion excursion over the whole sequence, metres and degrees. */
  motionExcursion: { camera: number; translationMm: number; rotationDeg: number }[];
  /**
   * Per camera, how far the camera moved BETWEEN THE TWO EPOCHS a
   * correspondence is read from — the `u` phase block and the `v` phase block,
   * four frames apart.
   *
   * This is the quantity `packages/solver`'s differential u-vs-v camera pose
   * estimates, and it is five to ten times SMALLER than `motionExcursion`. The
   * two were treated as the same measurement for a round and they are not:
   * round 3's critic measured 0.070 deg recovered against 0.35 deg of
   * excursion and correctly called the comparison wrong by 5x.
   */
  epochDisplacement: { camera: number; translationMm: number; rotationDeg: number }[];
  /**
   * Per camera, where it ACTUALLY WAS at its own reference epoch — the mean of
   * the epochs its own correspondences carry.
   *
   * The bench holds the motion states, so this is ground truth rather than an
   * estimate, and it is the pose a recovered camera pose should be scored
   * against: `packages/solver` centres its reported pose on exactly this epoch.
   * Scoring against the static placement instead is what made the
   * `camera_pose_rotation` gate unreachable — see `score.ts`.
   *
   * Computed from the DECODE's own reported epochs (`Correspondence.timeU` and
   * `timeV`), not from any solver-internal convention: the decoder is the thing
   * that says when it measured what, and both sides read that same public
   * statement.
   */
  cameraPoseAtEpoch: CameraPose[];
  /** The reference epoch itself, in pattern frames, per camera. */
  cameraEpochFrame: number[];
}

// ---------------------------------------------------------------------------
// Geometry pass
// ---------------------------------------------------------------------------

/**
 * What one camera sees of one projector, at one instant.
 *
 * Typed arrays rather than an array of records: this is the hottest structure in
 * the bench and, under handheld motion, it is rebuilt for every frame.
 */
interface Geometry {
  width: number;
  height: number;
  /** 1 where this projector's light reaches the surface point behind the pixel. */
  lit: Uint8Array;
  /** Projector raster coordinate, continuous. */
  u: Float32Array;
  v: Float32Array;
  /** `cos(incidence) * inverse-square falloff` — the whole geometric factor. */
  k: Float32Array;
  /** 1 where the camera ray hit the sphere at all (lit or not). */
  onSphere: Uint8Array;
  /**
   * 1 where the ray MISSED the sphere, hit the room, and this projector's
   * pattern reaches that point. `u`, `v` and `k` are then the room point's, and
   * mean exactly what they mean on the sphere. Always 0 when `roomSpill` is off.
   */
  onRoom: Uint8Array;
}

function makeGeometry(width: number, height: number): Geometry {
  const n = width * height;
  return {
    width,
    height,
    lit: new Uint8Array(n),
    u: new Float32Array(n),
    v: new Float32Array(n),
    k: new Float32Array(n),
    onSphere: new Uint8Array(n),
    onRoom: new Uint8Array(n),
  };
}

/**
 * Where a ray that missed the sphere meets the room, and the surface normal
 * there.
 *
 * A closed cylinder about the sphere's axis: wall, floor, ceiling. The wall root
 * taken is the POSITIVE one — the camera is inside the room, so `c < 0` and
 * there is exactly one — and it counts only between the floor and the ceiling;
 * otherwise the ray leaves through one of the caps. `null` is a ray that reaches
 * none of the three, which a closed room only produces for a direction almost
 * exactly along the axis at the axis, and for numerically degenerate input.
 */
export function roomHit(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  spill: RoomSpill,
  floorZ: number,
): { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null {
  const ceilZ = floorZ + spill.ceilingM;
  const rr = spill.wallRadiusM * spill.wallRadiusM;
  let best = Infinity;
  let out: { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null = null;

  const a = dir.x * dir.x + dir.y * dir.y;
  if (a > 1e-12) {
    const b = 2 * (origin.x * dir.x + origin.y * dir.y);
    const c = origin.x * origin.x + origin.y * origin.y - rr;
    const disc = b * b - 4 * a * c;
    if (disc > 0) {
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      const z = origin.z + dir.z * t;
      if (t > 1e-6 && z >= floorZ && z <= ceilZ) {
        const x = origin.x + dir.x * t;
        const y = origin.y + dir.y * t;
        const inv = 1 / spill.wallRadiusM;
        // Inward: the room is lit from inside.
        best = t;
        out = { x, y, z, nx: -x * inv, ny: -y * inv, nz: 0 };
      }
    }
  }

  if (Math.abs(dir.z) > 1e-12) {
    for (const planeZ of [floorZ, ceilZ]) {
      const t = (planeZ - origin.z) / dir.z;
      if (!(t > 1e-6) || t >= best) continue;
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      if (x * x + y * y > rr) continue;
      best = t;
      out = { x, y, z: planeZ, nx: 0, ny: 0, nz: planeZ === floorZ ? 1 : -1 };
    }
  }
  return out;
}

/**
 * Trace one camera against one projector, filling `geom`.
 *
 * `poseForRow` is asked once per row, which is exactly the granularity a
 * rolling shutter has: a row is read at one instant. For a global shutter or a
 * static camera the callback returns the same pose for every row and the whole
 * frame is coherent.
 *
 * The geometric factor `k` is `cos(incidence)` times `(d-R)^2 / dist^2`,
 * matching `packages/sim`'s `lambertianShading` term for term — PARAMETERS.md's
 * Radiometry convention normalizes a projector's output to the centre of its own
 * footprint, which sits at `d - R`, so that is the reference distance and not
 * `d`.
 */
function traceGeometry(
  geom: Geometry,
  canonical: Float64Array,
  poseForRow: (row: number) => { rotation: readonly number[]; ox: number; oy: number; oz: number },
  proj: PreparedProjector,
  radiusM: number,
  minIncidenceCos: number,
  spill: RoomSpill | null,
  floorZ: number,
): number {
  const { width, height } = geom;
  const refDist = proj.distanceM - radiusM;
  const refDistSq = refDist * refDist;
  const invR = 1 / radiusM;
  let traced = 0;

  for (let y = 0; y < height; y++) {
    const pose = poseForRow(y);
    const m = pose.rotation;
    const origin = { x: pose.ox, y: pose.oy, z: pose.oz };
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = 3 * i;
      const cx = canonical[c];
      const cy = canonical[c + 1];
      const cz = canonical[c + 2];
      const dx = m[0] * cx + m[1] * cy + m[2] * cz;
      const dy = m[3] * cx + m[4] * cy + m[5] * cz;
      const dz = m[6] * cx + m[7] * cy + m[8] * cz;
      const len = Math.hypot(dx, dy, dz);
      const dir = { x: dx / len, y: dy / len, z: dz / len };
      traced++;

      const hit = raySphereIntersect(origin, dir, radiusM);
      if (hit === null) {
        geom.onSphere[i] = 0;
        geom.lit[i] = 0;
        geom.onRoom[i] = 0;
        if (spill !== null) {
          const rp = roomHit(origin, dir, spill, floorZ);
          if (rp !== null) {
            const lx = proj.lens.x - rp.x;
            const ly = proj.lens.y - rp.y;
            const lz = proj.lens.z - rp.z;
            const dist = Math.hypot(lx, ly, lz);
            const cos = (rp.nx * lx + rp.ny * ly + rp.nz * lz) / dist;
            // Facing the lens at all. NOT §4.3's usability threshold: that is a
            // statement about whether a fringe on the SPHERE can be decoded, and
            // applying it here would delete grazing spill the decoder is
            // perfectly capable of accepting — which is the thing being measured.
            if (cos > 0) {
              // The sphere in the way. Its shadow on the wall is unmodulated,
              // and a real capture has one.
              const inv = 1 / dist;
              const toward = { x: -lx * inv, y: -ly * inv, z: -lz * inv };
              const blocked = raySphereIntersect(proj.lens, toward, radiusM);
              if (blocked === null || blocked.t >= dist) {
                const px = worldToPixel(proj, rp);
                if (px !== null) {
                  geom.onRoom[i] = 1;
                  geom.u[i] = px.u;
                  geom.v[i] = px.v;
                  geom.k[i] = cos * (refDistSq / (dist * dist));
                }
              }
            }
          }
        }
        continue;
      }
      geom.onSphere[i] = 1;
      geom.onRoom[i] = 0;

      const p = hit.point;
      const nx = p.x * invR;
      const ny = p.y * invR;
      const nz = p.z * invR;
      const lx = proj.lens.x - p.x;
      const ly = proj.lens.y - p.y;
      const lz = proj.lens.z - p.z;
      const dist = Math.hypot(lx, ly, lz);
      const cos = (nx * lx + ny * ly + nz * lz) / dist;
      if (cos < minIncidenceCos) {
        geom.lit[i] = 0;
        continue;
      }
      const px = worldToPixel(proj, p);
      if (px === null) {
        geom.lit[i] = 0;
        continue;
      }
      geom.lit[i] = 1;
      geom.u[i] = px.u;
      geom.v[i] = px.v;
      geom.k[i] = cos * (refDistSq / (dist * dist));
    }
  }
  return traced;
}

// ---------------------------------------------------------------------------
// Photometry
// ---------------------------------------------------------------------------

/**
 * The scalar luminance response of the surface to one projector.
 *
 * Collapses PARAMETERS.md §1's per-channel reflectance, §3.2's per-channel gain
 * and black floor, §5's ambient and the Rec.709 weights into two numbers plus a
 * clamp. See `patterns.ts` for why the per-channel GAMMA is absent: the pattern
 * is specified in linear radiance, so the transfer inverts exactly and gamma
 * cancels. The black floor does not cancel, and it is the term that sets the
 * modulation floor the decoder rejects on.
 */
interface LuminanceResponse {
  /** Surface luminance with the projector emitting nothing at all. */
  ambientLum: number;
  /** Emitted luminance for a target linear radiance. */
  emit(target: number): number;
}

function luminanceResponse(
  transfer: RigCalibration['projectors'][number]['transfer'],
  reflectance: ChannelTriplet,
  ambient: number,
): LuminanceResponse {
  const w = LUMINANCE_WEIGHTS;
  const wr = w.r * reflectance.r;
  const wg = w.g * reflectance.g;
  const wb = w.b * reflectance.b;
  return {
    ambientLum: ambient * (wr + wg + wb),
    emit(target: number): number {
      const e = emittedRadianceForTarget(target, transfer);
      return wr * e.r + wg * e.g + wb * e.b;
    },
  };
}

/**
 * Photon shot noise, read noise, saturation, quantization — in that order,
 * which is the order a sensor does them in.
 *
 * Returned as a closure with the sensor's constants already resolved. This runs
 * once per pixel per frame — thirty million times in a default scenario — and
 * the difference between reading four properties off an object each time and
 * reading four captured locals is not a micro-optimisation at that count, it is
 * most of the scenario's wall clock.
 *
 * Noise is applied to EVERY pixel, including the ones that miss the sphere.
 * Suppressing it there would be tempting — those pixels carry no pattern, so
 * their noise cannot inform anything — and it would also quietly delete a real
 * failure mode. A background pixel's modulation is zero plus noise, and across
 * the nine hundred thousand background pixels of one scenario a couple will
 * exceed the decoder's `minModulation` by chance and emit a correspondence with
 * a meaningless projector coordinate. Whether the robust loss absorbs those is
 * a genuine question about the solver, and it is one this bench should be able
 * to ask.
 */
function makeSensor(sensor: SensorModel | null, rng: BenchRng): (value: number) => number {
  if (sensor === null) return (value: number): number => value;
  const invElectrons = 1 / sensor.electronsPerUnitRadiance;
  const readVar = sensor.readNoiseElectrons * invElectrons * (sensor.readNoiseElectrons * invElectrons);
  const saturation = sensor.saturationRadiance;
  const step =
    sensor.quantizationBits === null
      ? 0
      : saturation / (Math.pow(2, sensor.quantizationBits) - 1);
  return (value: number): number => {
    // var(L) = var(N)/g^2 = N/g^2 = L/g with N Poisson, so the shot variance in
    // radiance units is the signal divided by the electrons-per-unit gain.
    const signal = value > 0 ? value : 0;
    let out = value + rng.gaussian() * Math.sqrt(signal * invElectrons + readVar);
    if (out < 0) out = 0;
    else if (out > saturation) out = saturation;
    if (step > 0) out = Math.round(out / step) * step;
    return out;
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface RenderedSequence {
  capture: PatternCapture;
  framesRendered: number;
  pixelsTraced: number;
  preview: RgbImage | null;
}

/** One rendered frame, with enough context to caption it. */
export interface PreviewFrame {
  camera: number;
  projector: number;
  /** Index into `planFrames(plan)`. */
  frame: number;
  image: RgbImage;
}

function renderPair(
  prepared: PreparedRig,
  cameras: readonly SimulatedCamera[],
  canonicals: readonly Float64Array[],
  motionStates: readonly MotionState[],
  cameraIndex: number,
  projectorIndex: number,
  opts: CaptureOptions,
  wantPreview: boolean,
): RenderedSequence {
  const cam = cameras[cameraIndex];
  const proj = prepared.projectors[projectorIndex];
  const width = cam.intrinsics.resX;
  const height = cam.intrinsics.resY;
  const canonical = canonicals[cameraIndex];
  const cond = opts.conditions;

  const response = luminanceResponse(proj.cal.transfer, cond.reflectance, cond.ambient);
  const background = response.ambientLum * cond.roomAlbedo;
  // The room reflects the pattern with the same reflectance the ambient
  // background already assumes for it: the sphere's paint, scaled by §5's
  // rho_room. `emitted` carries the paint already, so this is the scale left.
  const roomAlbedo = cond.roomAlbedo;
  const floorZ = -prepared.centerHeightM;
  const specs = planFrames(opts.plan);
  const geom = makeGeometry(width, height);

  // Noise is drawn from a stream owned by this (camera, projector) pair, walked
  // in a fixed (frame, pixel) order. Pairs are therefore independent of each
  // other and of how many pairs came first, so a scenario that changes its
  // camera count does not reshuffle the noise of the cameras it kept.
  const rng = makeBenchRng(
    (opts.seed ^ (cameraIndex * 0x9e3779b1) ^ (projectorIndex * 0x85ebca77)) >>> 0,
  );

  const stateless = cond.handheld === null;
  let pixelsTraced = 0;
  let geometryValid = false;

  const poseProviderFor = (frameIndex: number): ((row: number) => {
    rotation: readonly number[];
    ox: number;
    oy: number;
    oz: number;
  }) => {
    if (stateless) {
      const rot = rotationOf(cam.pose);
      const p = cam.pose.position;
      const fixed = { rotation: rot, ox: p.x, oy: p.y, oz: p.z };
      return () => fixed;
    }
    return (row: number) => {
      const t = rowTimeSec(cond.clock, frameIndex, row, height);
      const pose = poseAt(cam.pose, cond.handheld, motionStates[cameraIndex], t);
      return {
        rotation: rotationOf(pose),
        ox: pose.position.x,
        oy: pose.position.y,
        oz: pose.position.z,
      };
    };
  };

  const frames: LinearImage[] = [];
  let preview: RgbImage | null = null;
  const noisy = makeSensor(cond.sensor, rng);
  const ambientLum = response.ambientLum;
  const resX = proj.cal.intrinsics.resX;
  const resY = proj.cal.intrinsics.resY;
  // A Gray plane, a white frame and a black frame each ask for one of only two
  // target radiances, so their emitted luminance is a constant that can be
  // hoisted out of the pixel loop. Twenty-six of a thirty-four frame sequence
  // are of that kind; only the eight phase frames vary per pixel.
  const emitOn = response.emit(1);
  const emitOff = response.emit(0);

  for (let f = 0; f < specs.length; f++) {
    if (!stateless || !geometryValid) {
      pixelsTraced += traceGeometry(
        geom,
        canonical,
        poseProviderFor(f),
        proj,
        prepared.radiusM,
        cond.minIncidenceCos,
        cond.roomSpill,
        floorZ,
      );
      geometryValid = true;
    }
    const spec = specs[f];
    const frame = compileFrame(spec, opts.plan, resX, resY);
    const data = new Float32Array(width * height);
    const n = data.length;

    if (frame.axis === null) {
      // White and black frames: one target across the whole raster, so the
      // emitted luminance is a constant and the loop is a blit plus noise.
      const emitted = frame.at(0) >= 0.5 ? emitOn : emitOff;
      for (let i = 0; i < n; i++) {
        const value =
          geom.lit[i] === 1
            ? ambientLum + emitted * geom.k[i]
            : geom.onSphere[i] === 1
              ? ambientLum
              : geom.onRoom[i] === 1
                ? background + emitted * geom.k[i] * roomAlbedo
                : background;
        data[i] = noisy(value);
      }
    } else {
      const coord = frame.axis === 'u' ? geom.u : geom.v;
      const binary = spec.kind === 'gray' || spec.kind === 'grayInverse';
      for (let i = 0; i < n; i++) {
        let value: number;
        if (geom.lit[i] === 1) {
          const target = frame.at(coord[i]);
          // A Gray plane's target is exactly 0 or 1, so its emitted luminance
          // is one of two hoisted constants. The phase frames genuinely vary.
          const emitted = binary ? (target >= 0.5 ? emitOn : emitOff) : response.emit(target);
          value = ambientLum + emitted * geom.k[i];
        } else if (geom.onSphere[i] === 1) {
          value = ambientLum;
        } else if (geom.onRoom[i] === 1) {
          // The wall, carrying the same pattern at its own projector coordinate.
          // This is the whole point of `roomSpill`: the pixel is no longer
          // frame-invariant, so `white - black` is a real modulation and the
          // decoder has to decide about it rather than reject it for free.
          const target = frame.at(coord[i]);
          const emitted = binary ? (target >= 0.5 ? emitOn : emitOff) : response.emit(target);
          value = background + emitted * geom.k[i] * roomAlbedo;
        } else {
          value = background;
        }
        data[i] = noisy(value);
      }
    }

    frames.push({ width, height, channels: 1, data });
    if (wantPreview && f === opts.previewFrame) {
      preview = createImage(width, height);
      for (let i = 0; i < n; i++) {
        preview.data[3 * i] = data[i];
        preview.data[3 * i + 1] = data[i];
        preview.data[3 * i + 2] = data[i];
      }
    }
  }

  // Reassemble the flat frame list into the structure decode.ts expects. The
  // order here must match planFrames exactly; it is one function's output being
  // read back by one function, and the test asserts a round trip.
  let cursor = 0;
  const take = (): LinearImage => frames[cursor++];
  const white = opts.plan.includeWhiteBlack ? take() : null;
  const black = opts.plan.includeWhiteBlack ? take() : null;
  const gray: GraySequence[] = [];
  for (const axis of ['u', 'v'] as const) {
    const patterns: LinearImage[] = [];
    const inverses: LinearImage[] = [];
    for (let j = 0; j < opts.plan.grayBits; j++) {
      patterns.push(take());
      inverses.push(take());
    }
    gray.push({
      axis,
      bits: opts.plan.grayBits,
      stridePx: strideFor(
        axis === 'u' ? proj.cal.intrinsics.resX : proj.cal.intrinsics.resY,
        opts.plan.grayBits,
      ),
      patterns,
      inverses,
    });
  }
  const phase: PhaseSequence[] = [];
  for (const axis of ['u', 'v'] as const) {
    const stepFrames: LinearImage[] = [];
    for (let n = 0; n < opts.plan.phaseSteps; n++) stepFrames.push(take());
    const stride = strideFor(
      axis === 'u' ? proj.cal.intrinsics.resX : proj.cal.intrinsics.resY,
      opts.plan.grayBits,
    );
    phase.push({
      axis,
      steps: opts.plan.phaseSteps,
      periodPx: stride * opts.plan.phasePeriodStrides,
      frames: stepFrames,
    });
  }

  return {
    capture: {
      camera: cameraIndex,
      projector: projectorIndex,
      projectorRes: { x: proj.cal.intrinsics.resX, y: proj.cal.intrinsics.resY },
      white,
      black,
      gray,
      phase,
    },
    framesRendered: specs.length,
    pixelsTraced,
    preview,
  };
}

/**
 * Render and decode every (camera, projector) pair.
 *
 * Rendered and decoded one pair at a time rather than all at once. A 34-frame
 * sequence at 320x240 is 10 MB of float buffers; twelve of them alive at once
 * would be 125 MB, and a thorough preset at 640x480 would be half a gigabyte
 * for no reason. Streaming changes nothing about the computation — the
 * correspondences handed to `solve()` are the same objects `decodeAll` would
 * have produced from the same captures, in the same order — it only decides how
 * long the frames live.
 */
/** What the silhouette detector did for one camera, so a run can be audited. */
export interface SilhouetteReport {
  camera: number;
  /** Index of the chosen component in the size-ordered list, or -1 for none. */
  chosen: number;
  componentCount: number;
  /** Pixels the mask keeps. Zero means the camera contributed nothing. */
  maskPixels: number;
  threshold: number;
  warnings: string[];
}

/**
 * Build one camera's sphere mask from every projector it saw.
 *
 * The union across projectors, because a single projector lights a CRESCENT of
 * the ball -- the page's own copy says so -- and a crescent is not
 * distinguishable from a lit patch of floor by shape. Turning them all on gives
 * the disc back. That is not a trick of the simulator either: it corresponds to
 * one extra photograph with every projector lit, which is a thing a person
 * standing in the room can take.
 */
function maskForCamera(
  pending: readonly { projector: number; capture: PatternCapture }[],
  opts: CaptureOptions,
): { mask: Uint8Array; report: Omit<SilhouetteReport, 'camera'> } {
  const first = pending[0]?.capture.white;
  if (first === undefined || first === null) {
    throw new Error(
      'capture: image segmentation needs the all-on and all-off frames. Set ' +
        'includeWhiteBlack on the pattern plan.',
    );
  }
  const width = first.width;
  const height = first.height;
  const lit = new Float64Array(width * height);
  for (const { capture } of pending) {
    const w = capture.white;
    const b = capture.black;
    if (w === null || b === null) {
      throw new Error('capture: image segmentation needs white and black frames on every capture.');
    }
    const stride = w.channels;
    for (let i = 0; i < lit.length; i++) {
      // Channel 0 throughout: the detector wants radiance, not colour, and the
      // renderer writes the same value to every channel for a white frame.
      const v = w.data[i * stride] - b.data[i * stride];
      if (v > lit[i]) lit[i] = v;
    }
  }
  const seg = segmentSphere(lit, width, height, opts.conditions.segmentImage ?? {});
  let maskPixels = 0;
  for (let i = 0; i < seg.mask.length; i++) maskPixels += seg.mask[i];
  return {
    mask: seg.mask,
    report: {
      chosen: seg.chosen,
      componentCount: seg.components.length,
      maskPixels,
      threshold: seg.threshold,
      warnings: seg.warnings,
    },
  };
}

export function captureAndDecode(
  rig: RigCalibration,
  cameras: readonly SimulatedCamera[],
  opts: CaptureOptions,
): CaptureResult {
  const prepared = prepareRig(rig);
  const canonicals = cameras.map((c) => canonicalRayTable(c.intrinsics));
  const motionSeed = makeBenchRng((opts.seed ^ 0x5bf03635) >>> 0);
  const motionStates = cameras.map(() => makeMotionState(motionSeed));

  const correspondences: Correspondence[] = [];
  const perPair: PairStats[] = [];
  let framesRendered = 0;
  let pixelsTraced = 0;
  let preview: RgbImage | null = null;
  const previews: PreviewFrame[] = [];
  const stats: DecodeStats = {
    considered: 0,
    accepted: 0,
    rejectedLowModulation: 0,
    rejectedOffSphere: 0,
    rejectedOffImage: 0,
    rejectedGrayAmbiguous: 0,
    rejectedPhaseWeak: 0,
    rejectedDisagreement: 0,
    rejectedOutOfRange: 0,
    rejectedMissingAxis: 0,
  };

  const imageMasking = opts.conditions.segmentImage !== null;
  const pending: { projector: number; capture: PatternCapture }[] = [];
  const silhouettes: SilhouetteReport[] = [];

  /** Decode one pair and fold its numbers in. The only place that happens. */
  const consume = (
    c: number,
    p: number,
    capture: PatternCapture,
    mask: Uint8Array | null,
  ): void => {
    const decodeOpts =
      mask === null
        ? opts.decode
        : { ...opts.decode, imageMask: (_cam: number, pixel: number) => mask[pixel] === 1 };
    const decoded = decodeCapture(capture, decodeOpts);
    for (const corr of decoded.correspondences) correspondences.push(corr);
    perPair.push({
      camera: c,
      projector: p,
      considered: decoded.stats.considered,
      accepted: decoded.correspondences.length,
    });
    stats.considered += decoded.stats.considered;
    stats.accepted += decoded.stats.accepted;
    stats.rejectedLowModulation += decoded.stats.rejectedLowModulation;
    stats.rejectedOffSphere += decoded.stats.rejectedOffSphere;
    stats.rejectedOffImage += decoded.stats.rejectedOffImage;
    stats.rejectedGrayAmbiguous += decoded.stats.rejectedGrayAmbiguous;
    stats.rejectedPhaseWeak += decoded.stats.rejectedPhaseWeak;
    stats.rejectedDisagreement += decoded.stats.rejectedDisagreement;
    stats.rejectedOutOfRange += decoded.stats.rejectedOutOfRange;
    stats.rejectedMissingAxis += decoded.stats.rejectedMissingAxis;
  };

  for (let c = 0; c < cameras.length; c++) {
    for (let p = 0; p < prepared.projectors.length; p++) {
      const wantPreview = opts.previewPairs.some((q) => q.camera === c && q.projector === p);
      const rendered = renderPair(
        prepared,
        cameras,
        canonicals,
        motionStates,
        c,
        p,
        opts,
        wantPreview,
      );
      framesRendered += rendered.framesRendered;
      pixelsTraced += rendered.pixelsTraced;
      if (rendered.preview !== null) {
        preview = rendered.preview;
        previews.push({ camera: c, projector: p, frame: opts.previewFrame, image: rendered.preview });
      }

      if (imageMasking) {
        // The mask is built from every projector at once, so nothing for this
        // camera can be decoded until all of them are rendered. See `consume`.
        pending.push({ projector: p, capture: rendered.capture });
        continue;
      }
      consume(c, p, rendered.capture, null);
    }

    if (imageMasking) {
      const seg = maskForCamera(pending, opts);
      silhouettes.push({ camera: c, ...seg.report });
      for (const q of pending) consume(c, q.projector, q.capture, seg.mask);
      pending.length = 0;
    }
  }

  // How far the camera actually moved over the sequence, reported rather than
  // assumed: a rolling-shutter condition whose motion turned out to be
  // negligible would otherwise look like a rolling-shutter condition that did
  // not matter.
  const frameCount = planFrames(opts.plan).length;
  const totalSec =
    ((frameCount - 1) * opts.conditions.clock.frameIntervalMs +
      (opts.conditions.clock.rollingShutter ? opts.conditions.clock.readoutMs : 0)) /
    1000;
  const motionExcursion = cameras.map((cam, i) => {
    let maxT = 0;
    let maxR = 0;
    const steps = 200;
    for (let s = 0; s <= steps; s++) {
      const t = (totalSec * s) / steps;
      const pose = poseAt(cam.pose, opts.conditions.handheld, motionStates[i], t);
      maxT = Math.max(
        maxT,
        Math.hypot(
          pose.position.x - cam.pose.position.x,
          pose.position.y - cam.pose.position.y,
          pose.position.z - cam.pose.position.z,
        ),
      );
      maxR = Math.max(
        maxR,
        Math.hypot(
          pose.yawDeg - cam.pose.yawDeg,
          pose.pitchDeg - cam.pose.pitchDeg,
          pose.rollDeg - cam.pose.rollDeg,
        ),
      );
    }
    return { camera: i, translationMm: maxT * 1000, rotationDeg: maxR };
  });

  // Where each camera was when the decode says it measured what it measured.
  // The epochs come off the correspondences themselves, so this stays correct
  // if the pattern plan changes the frame order — and stays honest, because it
  // is the decoder's own statement about its own timing rather than a second
  // copy of the frame layout maintained here.
  const sumEpoch = new Float64Array(cameras.length);
  const countEpoch = new Float64Array(cameras.length);
  const sumU = new Float64Array(cameras.length);
  const sumV = new Float64Array(cameras.length);
  // The camera ROW matters as well as the frame, because a rolling shutter
  // reads row r later than row 0 and the correspondences of a sphere in the
  // middle of the frame are not spread symmetrically over the rows. Taking the
  // mean row of that camera's own correspondences removes the readout term
  // from the epoch instead of assuming it cancels.
  const sumRow = new Float64Array(cameras.length);
  for (const c of correspondences) {
    if (c.camera < 0 || c.camera >= cameras.length) continue;
    sumEpoch[c.camera] += (c.timeU + c.timeV) / 2;
    sumU[c.camera] += c.timeU;
    sumV[c.camera] += c.timeV;
    sumRow[c.camera] += c.camV;
    countEpoch[c.camera]++;
  }
  const cameraEpochFrame: number[] = [];
  const cameraPoseAtEpoch: CameraPose[] = [];
  const epochDisplacement: CaptureResult['epochDisplacement'] = [];
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i];
    const n = countEpoch[i];
    const frame = n > 0 ? sumEpoch[i] / n : 0;
    const height = cam.intrinsics.resY;
    const row = n > 0 ? sumRow[i] / n : (height - 1) / 2;
    const at = (f: number): number => rowTimeSec(opts.conditions.clock, f, row, height);
    cameraEpochFrame.push(frame);
    cameraPoseAtEpoch.push(poseAt(cam.pose, opts.conditions.handheld, motionStates[i], at(frame)));
    const fu = n > 0 ? sumU[i] / n : 0;
    const fv = n > 0 ? sumV[i] / n : 0;
    const a = poseAt(cam.pose, opts.conditions.handheld, motionStates[i], at(fu));
    const b = poseAt(cam.pose, opts.conditions.handheld, motionStates[i], at(fv));
    epochDisplacement.push({
      camera: i,
      translationMm:
        Math.hypot(
          b.position.x - a.position.x,
          b.position.y - a.position.y,
          b.position.z - a.position.z,
        ) * 1000,
      rotationDeg: Math.hypot(
        b.yawDeg - a.yawDeg,
        b.pitchDeg - a.pitchDeg,
        b.rollDeg - a.rollDeg,
      ),
    });
  }

  return {
    correspondences,
    stats,
    perPair,
    framesRendered,
    pixelsTraced,
    preview,
    previews,
    silhouettes,
    motionExcursion,
    epochDisplacement,
    cameraPoseAtEpoch,
    cameraEpochFrame,
  };
}

/** Frame specs for a plan, re-exported so a caller can name a preview frame. */
export function frameSpecsFor(plan: PatternPlan): FrameSpec[] {
  return planFrames(plan);
}
