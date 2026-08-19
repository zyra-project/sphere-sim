/**
 * What kind of file the reader just handed the page, and whether it is the right
 * shape to go on a sphere.
 *
 * Two functions, both pure, both here rather than in `web/main.ts` for the same
 * reason: they are the rules, and the rules are the part worth testing. The
 * loaders around them are DOM and cannot run in Node.
 *
 * The aspect rule used to live inside the image loader. A video loader that
 * re-stated it would be a second copy of a number that must not drift — and the
 * failure is quiet, because a 16:9 clip stretched onto a sphere still looks like
 * a planet, just one whose poles are in the wrong place.
 */

/** Everything the page will try to put on the sphere. */
export type MediaKind = 'image' | 'video';

/**
 * Which loader a dropped file goes to.
 *
 * The MIME type first, because that is what the browser actually knows, and the
 * extension only as a fallback: a file dragged out of some archive tools arrives
 * with an empty `type`, and `.mp4` is not ambiguous.
 */
export function mediaKind(mimeType: string, fileName: string): MediaKind {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  return /\.(mp4|m4v|webm|mov|ogv)$/i.test(fileName) ? 'video' : 'image';
}

/**
 * How far from 2:1 a sphere map may be.
 *
 * Not zero, because a 1920x1080 file is 1.78:1 and must be refused while a
 * 2048x1024 one is exactly 2 and a 1998x1000 one — which encoders do produce —
 * is 1.998 and must not be. 0.08 accepts everything within four percent and
 * refuses 16:9 by a wide margin.
 */
export const ASPECT_TOLERANCE = 0.08;

/**
 * `null` when the raster can go on a sphere, and the sentence to show when it
 * cannot.
 *
 * A message rather than a boolean: the reader dropped a file and deserves to be
 * told what was wrong with it, and stretching the thing to fit would silently
 * move every coastline in latitude.
 */
export function equirectAspectError(width: number, height: number, what: string): string | null {
  if (!(width > 0 && height > 0)) return `that ${what} has no picture in it.`;
  const ratio = width / height;
  if (Math.abs(ratio - 2) <= ASPECT_TOLERANCE) return null;
  return (
    `that ${what} is ${width}×${height}, a ${ratio.toFixed(2)}:1 aspect. An equirectangular ` +
    'sphere map is 2:1 — stretching this one would put the poles in the wrong place.'
  );
}
