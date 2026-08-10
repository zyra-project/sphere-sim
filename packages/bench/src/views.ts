/**
 * The rendered artifacts: what the room looks like, and where the error is.
 *
 * ## Why the bench renders its own room view
 *
 * `packages/sim`'s `renderRoomView` takes ONE calibration and is therefore
 * incapable of showing misregistration — a forward model run against itself
 * paints the physically correct texel at the physically correct point, always.
 * Real misalignment is a disagreement between two calibrations: what the
 * compositor draws with, and where the lenses are. `metrics/index.ts` already
 * makes that distinction for the numbers; this module makes it for the picture,
 * so the image a critic looks at and the number a critic reads are describing
 * the same thing.
 *
 * The trace is the photometric extension of `metrics/registration.ts`'s
 * `placeTexel`, and it is built out of `packages/sim`'s own primitives rather
 * than re-derived:
 *
 *   1. Camera ray -> sphere -> surface point `X`.
 *   2. For each PHYSICAL projector that lights `X`: which of its pixels is that?
 *   3. What did the compositor write into that pixel? Trace the same pixel back
 *      out through the CONTENT calibration to `X'`, and read the content there.
 *   4. Emit that signal from the physical projector toward `X`, and shade.
 *
 * Step 3 is the whole thing. When the two calibrations agree, `X' = X` and the
 * image is correct. When they disagree, each projector paints the texel from
 * where it *believes* it is pointing, which is exactly what produces the
 * doubled and kinked grid lines PARAMETERS.md §1's note describes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChannelTriplet, Vec3 } from '../../calibration/src/index.ts';
import type { RgbImage } from '../../sim/src/equirect.ts';
import { createImage, sampleEquirect } from '../../sim/src/equirect.ts';
import {
  raySphereIntersect,
  worldLonToTextureLon,
  worldToLatLon,
} from '../../sim/src/geometry.ts';
import type { PreparedRig } from '../../sim/src/optics.ts';
import { pixelToRay, worldToPixel } from '../../sim/src/optics.ts';
import { coverageAndWeights, isIlluminatedAt, polarMask } from '../../sim/src/coverage.ts';
import type { ProjectorContribution } from '../../sim/src/shading.ts';
import { lambertianShading } from '../../sim/src/shading.ts';
import type { Scene, ViewerCamera } from '../../sim/src/render.ts';
import { blendedSignal } from '../../sim/src/render.ts';
import { hash01, radicalInverse } from '../../sim/src/random.ts';
import type { ScalarField } from '../../sim/src/metrics/index.ts';
import { encodePng8, viridis } from '../../sim/src/png.ts';
import { add, cross, dot, normalize, scale, sub } from '../../sim/src/vec.ts';
import { DEG2RAD } from '../../sim/src/vec.ts';

const BLACK: ChannelTriplet = { r: 0, g: 0, b: 0 };

export interface RoomViewOptions {
  samplesPerPixel?: number;
  seed?: number;
  drawFloor?: boolean;
  floorRadiusM?: number;
}

/**
 * A viewer camera looking at a sphere whose content was generated against a
 * different calibration from the one its lenses have.
 *
 * The floor is deliberately omitted from this renderer (`drawFloor` defaults
 * false) even though `sim`'s room view models it: the floor's appearance is the
 * projector black-floor spill of PARAMETERS.md §3.2, which is class ASSUME, and
 * these images accompany geometric numbers. A photometric feature in a geometric
 * artifact is an invitation to read it as evidence.
 */
export function renderTwoRigRoomView(
  physical: PreparedRig,
  content: PreparedRig,
  scene: Scene,
  camera: ViewerCamera,
  options: RoomViewOptions = {},
): RgbImage {
  const samples = Math.max(1, Math.floor(options.samplesPerPixel ?? 1));
  const seed = options.seed ?? 0;
  const shading = lambertianShading();

  const forward = normalize(sub(camera.target, camera.position));
  const upHint = camera.upHint ?? { x: 0, y: 0, z: 1 };
  let right = cross(forward, upHint);
  if (dot(right, right) < 1e-18) right = cross(forward, { x: 1, y: 0, z: 0 });
  right = normalize(right);
  const up = cross(right, forward);
  const halfW = Math.tan((camera.fovHDeg * DEG2RAD) / 2);
  const halfH = (halfW * camera.height) / camera.width;

  const img = createImage(camera.width, camera.height);
  for (let y = 0; y < camera.height; y++) {
    for (let x = 0; x < camera.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let s = 0; s < samples; s++) {
        const [ox, oy] = sampleOffset(x, y, s, samples, seed);
        const sx = ((x + ox) / camera.width) * 2 - 1;
        const sy = 1 - ((y + oy) / camera.height) * 2;
        const dir = normalize(add(forward, add(scale(right, sx * halfW), scale(up, sy * halfH))));
        const c = traceTwoRig(camera.position, dir, physical, content, scene, shading);
        r += c.r;
        g += c.g;
        b += c.b;
      }
      const i = 3 * (y * camera.width + x);
      img.data[i] = r / samples;
      img.data[i + 1] = g / samples;
      img.data[i + 2] = b / samples;
    }
  }
  return img;
}

function traceTwoRig(
  origin: Vec3,
  dir: Vec3,
  physical: PreparedRig,
  content: PreparedRig,
  scene: Scene,
  shading: ReturnType<typeof lambertianShading>,
): ChannelTriplet {
  const hit = raySphereIntersect(origin, dir, physical.radiusM);
  if (hit === null) return BLACK;
  const point = hit.point;
  const invR = 1 / physical.radiusM;
  const normal = { x: point.x * invR, y: point.y * invR, z: point.z * invR };

  const contributions: ProjectorContribution[] = [];
  for (let i = 0; i < physical.projectors.length; i++) {
    const phys = physical.projectors[i];
    if (!isIlluminatedAt(point, phys)) continue;
    const px = worldToPixel(phys, point);
    if (px === null) continue;

    // What the compositor wrote into that pixel: trace it back out through the
    // calibration the compositor believed it had.
    const cProj = content.projectors[i];
    let signal: ChannelTriplet = BLACK;
    let weight = 0;
    if (cProj !== undefined) {
      const back = raySphereIntersect(cProj.lens, pixelToRay(cProj, px.u, px.v), content.radiusM);
      if (back !== null) {
        const ll = worldToLatLon(back.point);
        const target = sampleEquirect(
          scene.image,
          ll.latDeg,
          worldLonToTextureLon(ll.lonDeg, content.rotationOffsetDeg),
        );
        weight =
          coverageAndWeights(back.point, content).weights[i] *
          polarMask(ll.latDeg, content.blend, scene.maskInterpretation);
        signal = blendedSignal(target, weight, scene.encodeGamma);
      }
    }

    const toLensVec = sub(phys.lens, point);
    const distanceM = Math.hypot(toLensVec.x, toLensVec.y, toLensVec.z);
    contributions.push({
      projector: i,
      signal,
      weight,
      incidenceCos: dot(normal, toLensVec) / distanceM,
      distanceM,
      toLens: scale(toLensVec, 1 / distanceM),
      transfer: phys.cal.transfer,
      referenceDistanceM: phys.distanceM - physical.radiusM,
    });
  }

  return shading.shade({
    point,
    normal,
    viewDir: scale(dir, -1),
    contributions,
    reflectance: scene.reflectance,
    ambient: scene.ambient,
  });
}

/**
 * Sub-pixel offsets, the same Halton-plus-hash construction `sim/render.ts`
 * uses and for the same reason: the offsets must be a pure function of
 * `(x, y, s, seed)` so no future decision about iteration order can change a
 * single output byte, and they must be decorrelated between pixels so edge
 * aliasing does not turn into a moire that looks like the registration error
 * the image exists to show.
 */
function sampleOffset(
  x: number,
  y: number,
  s: number,
  samples: number,
  seed: number,
): [number, number] {
  if (samples === 1) return [0.5, 0.5];
  const rx = hash01(x, y, seed, 0x9e37);
  const ry = hash01(x, y, seed, 0x85eb);
  return [(radicalInverse(2, s + 1) + rx) % 1, (radicalInverse(3, s + 1) + ry) % 1];
}

// ---------------------------------------------------------------------------
// Field maps
// ---------------------------------------------------------------------------

/**
 * Colorize a scalar field, painting the undefined cells a flat neutral grey
 * rather than letting them fall off the bottom of the colormap.
 *
 * `metrics/registration.ts` marks cells that fewer than two projectors light
 * with `NaN`, and those cells are most of the sphere. Mapping them to the dark
 * end of viridis would make "no overlap here" and "no error here" the same
 * colour, which is the one confusion a registration map must not create.
 */
export function colorizeFieldWithGaps(
  field: ScalarField,
  lo: number,
  hi: number,
  displayGamma = 2.2,
): RgbImage {
  const img = createImage(field.width, field.height);
  const span = hi - lo;
  const missing = 0.35;
  for (let i = 0; i < field.width * field.height; i++) {
    const value = field.data[i];
    if (!Number.isFinite(value)) {
      img.data[3 * i] = Math.pow(missing, displayGamma);
      img.data[3 * i + 1] = Math.pow(missing, displayGamma);
      img.data[3 * i + 2] = Math.pow(missing, displayGamma);
      continue;
    }
    const t = span === 0 ? 0 : (value - lo) / span;
    const c = viridis(t);
    img.data[3 * i] = Math.pow(Math.min(1, Math.max(0, c.r)), displayGamma);
    img.data[3 * i + 1] = Math.pow(Math.min(1, Math.max(0, c.g)), displayGamma);
    img.data[3 * i + 2] = Math.pow(Math.min(1, Math.max(0, c.b)), displayGamma);
  }
  return img;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write a PNG and return its path relative to the repository root.
 *
 * The relative path is what goes into `bench-results.json`. An absolute path
 * would embed the machine the bench happened to run on into an artifact whose
 * whole purpose is to be compared byte-for-byte between two runs, and CI's
 * checkout directory is not the same as anybody's laptop.
 */
export function writePng(
  outDir: string,
  repoRoot: string,
  name: string,
  img: RgbImage,
  exposure = 1,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodePng8(img, { exposure, displayGamma: 2.2 }));
  return path.relative(repoRoot, file).split(path.sep).join('/');
}
