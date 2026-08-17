/**
 * The rendered artifacts: what the room looks like, and where the error is.
 *
 * ## The two-calibration room view moved
 *
 * `renderTwoRigRoomView` — the renderer that can actually show misregistration,
 * because it separates the calibration the compositor draws with from the one
 * the lenses have — now lives in `packages/sim/src/misregistration.ts`, and is
 * re-exported here so the bench's call sites did not have to move. It went there
 * because it is a renderer built out of `sim`'s own primitives, and because the
 * browser app needs it and cannot import a module that opens `node:fs`. Its
 * module note explains the trace.
 *
 * What is left in this file is the part that genuinely belongs to the bench:
 * turning those images and the metric fields into PNGs on disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RgbImage } from '../../sim/src/equirect.ts';
import { createImage } from '../../sim/src/equirect.ts';
import type { ScalarField } from '../../sim/src/metrics/index.ts';
import { encodePng8, viridis } from '../../sim/src/png.ts';

export type { RoomViewOptions } from '../../sim/src/misregistration.ts';
export { renderTwoRigRoomView, traceTwoRig } from '../../sim/src/misregistration.ts';


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
