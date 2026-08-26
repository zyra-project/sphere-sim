// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * Find the sphere in the photograph.
 *
 * ## Why this exists
 *
 * `sphere.ts` already offers a segmentation: ask whether a decoded projector ray
 * reaches the NOMINAL sphere. Experiment 4 measured it at a paired geometric
 * mean of 13.6x against a room, which is most of the damage — but not all, and
 * the residue is structural rather than incidental. That test uses the rig the
 * solve is trying to correct, so the correspondences it cannot reject are
 * exactly the ones displaced by the error being solved for: rays that miss the
 * TRUE sphere and hit the NOMINAL one. It is a segmentation that depends on the
 * answer.
 *
 * This one does not. It reads pixels and nothing else. There is no rig here, no
 * pose, no radius, no projector model and no camera model — which is why it
 * cannot leak ground truth into the solve by construction rather than by a test
 * asserting that it does not.
 *
 * ## What it assumes, which is the honest part
 *
 * One thing, and it is checkable in the image: the sphere does not touch the
 * frame edge and the room does. That is true of a photograph framed to contain
 * the ball and false the moment somebody crops in, so `selectSphere` reports
 * WHY it chose what it chose and the caller can refuse the answer. A silhouette
 * detector that silently returns the floor is worse than none, because the room
 * it hands the solver is a self-consistent lie of exactly the kind experiment 4
 * measured.
 *
 * ## What it is not
 *
 * Not a general segmenter. There is no learned model, no edge following, no
 * ellipse fit. It thresholds, labels, and picks, because that is what the
 * measurement needs and every part of it can be argued about in one sitting.
 */

/** A component of the thresholded image, and the evidence for keeping or dropping it. */
export interface Component {
  /** Pixels in it. */
  area: number;
  /** It runs into the edge of the frame, so the object continues outside. */
  touchesBorder: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /**
   * Area over the area of its bounding box.
   *
   * A disc fills pi/4 = 0.785 of its box. A lit floor sweeping diagonally fills
   * much less. Reported, not thresholded: it is evidence for a reader, and the
   * selection rule below deliberately does not depend on it.
   */
  fill: number;
}

export interface SilhouetteResult {
  /** One byte per pixel: 1 where the sphere is. */
  mask: Uint8Array;
  width: number;
  height: number;
  /** Every component found, largest first. */
  components: Component[];
  /** The index in `components` that was chosen, or -1 if none was. */
  chosen: number;
  /** The threshold Otsu picked, in the units of the lit image. */
  threshold: number;
  /**
   * Why the answer should or should not be trusted. Empty when the choice was
   * unambiguous.
   */
  warnings: string[];
}

export interface SilhouetteOptions {
  /**
   * Reject components that run into the frame edge.
   *
   * This is the whole discriminator. The room is behind and below the ball and
   * fills the frame, so a lit patch of it reaches an edge; the ball, framed,
   * does not.
   */
  rejectBorderComponents: boolean;
  /**
   * Below this many pixels a component is noise rather than an object.
   * Absolute, because it is a statement about the sensor and not about the scene.
   */
  minAreaPx: number;
  /**
   * Warn when the runner-up interior component is at least this fraction of the
   * winner. Two similar interior blobs means the rule did not actually decide.
   */
  ambiguityRatio: number;
}

export const DEFAULT_SILHOUETTE_OPTIONS: SilhouetteOptions = {
  rejectBorderComponents: true,
  minAreaPx: 32,
  ambiguityRatio: 0.5,
};

/**
 * Otsu's threshold over a float image.
 *
 * Chosen because it takes no parameter from anybody. A fixed fraction of the
 * maximum would be a constant with no provenance, and this experiment already
 * spent a page on what an unmeasured constant costs.
 */
export function otsuThreshold(lit: ArrayLike<number>, bins = 256): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < lit.length; i++) {
    const v = lit[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return Number.isFinite(lo) ? lo : 0;

  const hist = new Float64Array(bins);
  const scale = (bins - 1) / (hi - lo);
  let total = 0;
  for (let i = 0; i < lit.length; i++) {
    const v = lit[i];
    if (!Number.isFinite(v)) continue;
    hist[Math.round((v - lo) * scale)]++;
    total++;
  }
  if (total === 0) return lo;

  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];

  let wB = 0;
  let sumB = 0;
  let best = -1;
  let bestBin = 0;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestBin = b;
    }
  }
  return lo + bestBin / scale;
}

/**
 * Label the foreground into 8-connected components.
 *
 * Iterative, with an explicit stack: a 320x240 frame is 76 800 pixels and a
 * recursive flood fill on the sphere blows the call stack.
 */
function label(
  fg: Uint8Array,
  width: number,
  height: number,
): { ids: Int32Array; components: Component[] } {
  const ids = new Int32Array(width * height).fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];

  for (let seed = 0; seed < fg.length; seed++) {
    if (fg[seed] === 0 || ids[seed] !== -1) continue;
    const id = components.length;
    let area = 0;
    let touchesBorder = false;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    ids[seed] = id;
    stack.push(seed);
    while (stack.length > 0) {
      const at = stack.pop() as number;
      const x = at % width;
      const y = (at - x) / width;
      area++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (fg[n] === 0 || ids[n] !== -1) continue;
          ids[n] = id;
          stack.push(n);
        }
      }
    }

    const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
    components.push({ area, touchesBorder, minX, maxX, minY, maxY, fill: area / boxArea });
  }
  return { ids, components };
}

/**
 * Segment the sphere out of a lit image.
 *
 * `lit` is white minus black: the radiance the projectors put on the scene, with
 * ambient and the sensor's black floor already differenced away. Every pixel the
 * decoder can use is bright in it, which is exactly the population that needs
 * separating.
 */
export function segmentSphere(
  lit: ArrayLike<number>,
  width: number,
  height: number,
  options: Partial<SilhouetteOptions> = {},
): SilhouetteResult {
  const opts: SilhouetteOptions = { ...DEFAULT_SILHOUETTE_OPTIONS, ...options };
  const threshold = otsuThreshold(lit);
  const fg = new Uint8Array(width * height);
  for (let i = 0; i < fg.length; i++) fg[i] = lit[i] > threshold ? 1 : 0;

  const { ids, components } = label(fg, width, height);
  const order = components
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.area >= opts.minAreaPx)
    .sort((a, b) => b.c.area - a.c.area);

  const warnings: string[] = [];
  const interior = opts.rejectBorderComponents ? order.filter(({ c }) => !c.touchesBorder) : order;

  let chosen = -1;
  if (interior.length === 0) {
    warnings.push(
      order.length === 0
        ? 'nothing above the threshold: the frame holds no lit object'
        : 'every lit component runs into the frame edge, so none of them is a framed sphere',
    );
  } else {
    chosen = interior[0].i;
    if (interior.length > 1 && interior[1].c.area >= opts.ambiguityRatio * interior[0].c.area) {
      warnings.push(
        `two interior components of similar size (${interior[0].c.area} and ${interior[1].c.area} px): ` +
          'the border rule did not decide this, area did',
      );
    }
  }

  const mask = new Uint8Array(width * height);
  if (chosen >= 0) for (let i = 0; i < mask.length; i++) if (ids[i] === chosen) mask[i] = 1;

  // Largest first, so `chosen` is reported against a stable ordering.
  const sorted = [...components].sort((a, b) => b.area - a.area);
  const chosenInSorted = chosen < 0 ? -1 : sorted.indexOf(components[chosen]);
  return { mask, width, height, components: sorted, chosen: chosenInSorted, threshold, warnings };
}
