/**
 * Structured-light decode: camera images -> (camera pixel, projector pixel)
 * correspondences, each with an honest uncertainty.
 *
 * Two coding schemes, used together, because each covers the other's weakness:
 *
 *  - **Gray code** gives an unambiguous integer address with no unwrapping
 *    problem, and each bit is read by comparing a pattern against its own
 *    complement. That comparison is what makes it survive the sphere: the
 *    surface albedo, the ambient term (PARAMETERS.md §5, `E_amb` 0.01-0.15
 *    relative and unmeasured), and the cos-incidence falloff of §4.1 all scale
 *    the two frames identically and cancel in the difference. Only the sign
 *    survives, and the sign is the bit.
 *
 *  - **Phase shift** gives sub-pixel position but only modulo one fringe. The
 *    Gray code supplies the fringe order.
 *
 * Everything is decoded from LINEAR light. The images arrive as linear-light
 * float buffers, and the phase patterns are specified below as linear radiance
 * fractions, not as encoded signal. That is not a detail: conventions.ts §P
 * makes the projector's transfer `L = gain*((1-blackFloor)*V^gamma + blackFloor)`
 * with gamma per channel and class ASSUME, so a sinusoid emitted as *signal*
 * arrives at the sphere as a distorted sinusoid whose harmonics bias the phase
 * estimate. Specifying the pattern in linear radiance pushes that compensation
 * onto whoever generates the patterns, where the transfer is actually known,
 * and keeps an unmeasured photometric constant out of a geometric measurement.
 *
 * ---------------------------------------------------------------------------
 * PATTERN DEFINITION — normative for anyone generating input for this decoder.
 *
 * Let `s` be the projector-raster coordinate along the sequence's axis,
 * evaluated at the PIXEL CENTRE, so the first column's centre is s = 0.5
 * (conventions.ts §I).
 *
 * Gray, `bits` planes, MSB first, `stridePx = res / 2^bits`:
 *   code(s)      = clamp(floor(s / stridePx), 0, 2^bits - 1)
 *   gray(s)      = code XOR (code >> 1)
 *   pattern[j]   = 1 if bit (bits-1-j) of gray(s) is set, else 0
 *   inverse[j]   = 1 - pattern[j]
 *
 * Phase, `steps` frames, period `periodPx` projector pixels:
 *   frame[n](s)  = 0.5 + 0.5 * cos(2*pi*s/periodPx - 2*pi*n/steps)
 *
 * Use `steps >= 4`. An N-step estimator is blind to every harmonic except those
 * congruent to +/-1 mod N, so N=4 rejects the second and third harmonics that
 * any residual transfer nonlinearity produces, while N=3 rejects neither.
 *
 * Choose `periodPx` as an even multiple of `stridePx`, two being the natural
 * choice. The Gray address has to be FINER than one fringe or the fringe order
 * is not determined, and — less obviously — if `periodPx` equals `stridePx`
 * exactly then every Gray misread displaces the coarse estimate by a whole
 * number of fringes, the unwrap picks a different order, and the
 * Gray-versus-phase cross-check below can never fire. The cross-check is only
 * as good as the incommensurability between the two scales.
 * ---------------------------------------------------------------------------
 */

/** A linear-light image. `channels` is 1 (luminance) or 3 (RGB, interleaved). */
export interface LinearImage {
  width: number;
  height: number;
  channels: number;
  data: Float32Array | Float64Array;
}

export type DecodeAxis = 'u' | 'v';
export type DecodeChannel = 'luminance' | 'r' | 'g' | 'b';

export interface GraySequence {
  axis: DecodeAxis;
  bits: number;
  /** Projector pixels per code step. Normally `res / 2^bits`. */
  stridePx: number;
  /** MSB first. */
  patterns: LinearImage[];
  /** Complement of `patterns`, same order. */
  inverses: LinearImage[];
}

export interface PhaseSequence {
  axis: DecodeAxis;
  steps: number;
  periodPx: number;
  frames: LinearImage[];
}

/**
 * Everything one camera saw of one projector.
 *
 * One projector at a time is not a simplification, it is the capture protocol:
 * PARAMETERS.md §4.2 shows overlap multiplicity reaches 2 in the seams, and two
 * projectors patterning simultaneously would make the seam — the region the
 * whole exercise exists to align — the one region that cannot be decoded.
 */
export interface PatternCapture {
  camera: number;
  projector: number;
  projectorRes: { x: number; y: number };
  /** All-on and all-off frames. Optional; see `referencePlanes` for the fallback. */
  white: LinearImage | null;
  black: LinearImage | null;
  gray: GraySequence[];
  phase: PhaseSequence[];
}

export interface DecodeOptions {
  channel: DecodeChannel;
  /**
   * Absolute floor on the per-pixel (white - black) modulation. Below it the
   * pixel is off-sphere, shadowed, or past the limb, and nothing it reports is
   * meaningful. In the units of the input buffers, where conventions.ts §P
   * defines 1.0 as one projector's full output at the centre of its footprint.
   */
  minModulation: number;
  /** A Gray bit must separate by this fraction of the pixel's own modulation. */
  minBitSeparation: number;
  /** Phase amplitude must reach this fraction of the pixel's own modulation. */
  minPhaseModulation: number;
  /** Reject when Gray and phase disagree by more than this fraction of a period. */
  unwrapToleranceFrac: number;
  /** Assumed per-sample intensity noise when the fit cannot estimate one (steps < 4). */
  noiseSigma: number;
  /** Floor on reported sigma, projector pixels. */
  minSigmaPx: number;
  /** Take every Nth camera pixel in each axis. */
  pixelStride: number;
  /** 0 = keep everything. Otherwise decimate deterministically to this count. */
  maxCorrespondences: number;
}

export const DEFAULT_DECODE_OPTIONS: DecodeOptions = {
  channel: 'luminance',
  // 2% of a projector's full output. Comfortably above the black floor
  // (PARAMETERS.md §3.2 puts it near 1/800) and below anything a lit, non-grazing
  // surface returns.
  minModulation: 0.02,
  minBitSeparation: 0.25,
  minPhaseModulation: 0.15,
  // Two fifths of a fringe. The bound has to sit between two numbers: a CORRECT
  // decode disagrees by at most half a Gray stride, i.e. `stride / (2*period)`
  // of a fringe, and a wrong fringe order disagrees by at least half a fringe.
  // With the recommended `period = 2 * stride` those are 0.25 and 0.5, so 0.4
  // clears ordinary noise comfortably and still catches the order error.
  unwrapToleranceFrac: 0.4,
  noiseSigma: 0.01,
  // Sub-hundredth-pixel correspondences are not credible from any real camera,
  // and an unbounded 1/sigma weight lets one lucky pixel dominate the normal
  // equations.
  minSigmaPx: 0.01,
  pixelStride: 1,
  maxCorrespondences: 0,
};

/** One decoded camera-pixel-to-projector-pixel correspondence. */
export interface Correspondence {
  camera: number;
  projector: number;
  /** Camera pixel CENTRE, continuous coordinates (conventions.ts §I). */
  camU: number;
  camV: number;
  /** Decoded projector pixel, continuous. */
  projU: number;
  projV: number;
  /** One-sigma uncertainty in projector pixels, per axis. */
  sigmaU: number;
  sigmaV: number;
  /** Fringe amplitude over the pixel's white-black reference. Diagnostic. */
  modulation: number;
}

export interface DecodeStats {
  considered: number;
  accepted: number;
  rejectedLowModulation: number;
  rejectedGrayAmbiguous: number;
  rejectedPhaseWeak: number;
  rejectedDisagreement: number;
  rejectedOutOfRange: number;
  rejectedMissingAxis: number;
}

export function emptyStats(): DecodeStats {
  return {
    considered: 0,
    accepted: 0,
    rejectedLowModulation: 0,
    rejectedGrayAmbiguous: 0,
    rejectedPhaseWeak: 0,
    rejectedDisagreement: 0,
    rejectedOutOfRange: 0,
    rejectedMissingAxis: 0,
  };
}

// ---------------------------------------------------------------------------
// Gray code arithmetic
// ---------------------------------------------------------------------------

export function binaryToGray(v: number): number {
  return v ^ (v >>> 1);
}

export function grayToBinary(g: number, bits: number): number {
  let b = g;
  for (let shift = 1; shift < bits; shift <<= 1) b ^= b >>> shift;
  // Mask because the unrolled XOR can leave high bits set for inputs wider than
  // `bits`, which a noisy decode can produce.
  return b & ((1 << bits) - 1);
}

/** Bit `j` (0 = MSB) of the Gray code of `index`, as the pattern generator emits it. */
export function grayPatternBit(index: number, bits: number, j: number): number {
  return (binaryToGray(index) >>> (bits - 1 - j)) & 1;
}

// ---------------------------------------------------------------------------
// Pixel sampling
// ---------------------------------------------------------------------------

/**
 * Rec.709 linear luminance coefficients.
 *
 * The decode runs on luminance by default because it is the highest-SNR
 * combination of a three-channel capture and because PARAMETERS.md §3.2 warns
 * the channels diverge in gamma, gain and black floor — all of which cancel in a
 * pattern-minus-complement comparison but none of which are worth inviting into
 * a geometric measurement. A single channel can be selected when a rig has a
 * known channel problem.
 */
const LUM_R = 0.2126;
const LUM_G = 0.7152;
const LUM_B = 0.0722;

function scalarAt(img: LinearImage, pixel: number, channel: DecodeChannel): number {
  const d = img.data;
  if (img.channels === 1) return d[pixel];
  const base = pixel * img.channels;
  switch (channel) {
    case 'r':
      return d[base];
    case 'g':
      return d[base + 1];
    case 'b':
      return d[base + 2];
    default:
      return LUM_R * d[base] + LUM_G * d[base + 1] + LUM_B * d[base + 2];
  }
}

function assertSameSize(a: LinearImage, b: LinearImage, what: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `decode: ${what} has ${b.width}x${b.height}, expected ${a.width}x${a.height}`,
    );
  }
}

/** Every frame in a capture, in a fixed order, so validation and fallbacks agree. */
function allFrames(capture: PatternCapture): LinearImage[] {
  const frames: LinearImage[] = [];
  for (const g of capture.gray) {
    for (const f of g.patterns) frames.push(f);
    for (const f of g.inverses) frames.push(f);
  }
  for (const p of capture.phase) for (const f of p.frames) frames.push(f);
  return frames;
}

/**
 * Per-pixel white and black references.
 *
 * When the capture carries explicit all-on and all-off frames those are used
 * directly. When it does not, the Gray sequences supply them for free: every
 * pattern is paired with its exact complement, so for any pixel at least one
 * frame is fully lit and at least one is fully dark, and the per-pixel max and
 * min over the Gray frames ARE the white and black references. That fallback
 * costs two frames of capture time and loses nothing, which is worth knowing
 * when someone is standing in a dark room with a tethered camera and 35 frames
 * to shoot (PARAMETERS.md §8).
 */
function referencePlanes(
  capture: PatternCapture,
  opts: DecodeOptions,
): { white: Float64Array; black: Float64Array; width: number; height: number } {
  const frames = allFrames(capture);
  if (frames.length === 0) throw new Error('decode: capture contains no pattern frames');
  const first = capture.white ?? frames[0];
  const n = first.width * first.height;

  for (const f of frames) assertSameSize(first, f, 'pattern frame');
  if (capture.white) assertSameSize(first, capture.white, 'white frame');
  if (capture.black) assertSameSize(first, capture.black, 'black frame');

  const white = new Float64Array(n);
  const black = new Float64Array(n);

  if (capture.white && capture.black) {
    for (let i = 0; i < n; i++) {
      white[i] = scalarAt(capture.white, i, opts.channel);
      black[i] = scalarAt(capture.black, i, opts.channel);
    }
    return { white, black, width: first.width, height: first.height };
  }

  white.fill(-Infinity);
  black.fill(Infinity);
  for (const f of frames) {
    for (let i = 0; i < n; i++) {
      const s = scalarAt(f, i, opts.channel);
      if (s > white[i]) white[i] = s;
      if (s < black[i]) black[i] = s;
    }
  }
  return { white, black, width: first.width, height: first.height };
}

// ---------------------------------------------------------------------------
// Per-axis decode
// ---------------------------------------------------------------------------

interface AxisResult {
  ok: boolean;
  coord: number;
  sigma: number;
  modulation: number;
  reason: 'ok' | 'gray' | 'phase' | 'disagree' | 'range' | 'missing';
}

const FAIL: (reason: AxisResult['reason']) => AxisResult = (reason) => ({
  ok: false,
  coord: NaN,
  sigma: NaN,
  modulation: 0,
  reason,
});

/**
 * Read one Gray sequence at one pixel.
 *
 * Each bit is `pattern > inverse`. The confidence in a bit is how far apart the
 * two frames were; the weakest bit in the word governs, because a single
 * flipped bit is not a small error — flip the MSB and the decoded address moves
 * half a raster.
 */
function decodeGrayAt(
  seq: GraySequence,
  pixel: number,
  modulation: number,
  opts: DecodeOptions,
): { ok: boolean; index: number } {
  let gray = 0;
  const threshold = opts.minBitSeparation * modulation;
  for (let j = 0; j < seq.bits; j++) {
    const p = scalarAt(seq.patterns[j], pixel, opts.channel);
    const q = scalarAt(seq.inverses[j], pixel, opts.channel);
    if (Math.abs(p - q) < threshold) return { ok: false, index: 0 };
    gray = (gray << 1) | (p > q ? 1 : 0);
  }
  return { ok: true, index: grayToBinary(gray, seq.bits) };
}

interface PhaseFit {
  /** Wrapped phase in [0, 2*pi). */
  phase: number;
  /** Fringe amplitude, same units as the input. */
  amplitude: number;
  /** One-sigma phase uncertainty, radians. */
  sigmaPhase: number;
}

/**
 * N-step phase estimate at one pixel, with its uncertainty.
 *
 * The model is `I_n = A + B*cos(phi - 2*pi*n/N)`. Projecting onto cos and sin of
 * the step angles gives `B*cos(phi)` and `B*sin(phi)` directly, because the step
 * angles are equally spaced and their cross-products vanish — that is the whole
 * reason N-step phase shifting is written this way rather than as a general
 * least-squares fit.
 *
 * The uncertainty is the textbook `sigma_phi = sqrt(2/N) * sigma_I / B`, and
 * `sigma_I` is estimated from the fit's own residual whenever there are enough
 * frames to have residual left (N > 3 leaves N-3 degrees of freedom). Measuring
 * the noise instead of assuming it matters here: PARAMETERS.md gives no sensor
 * noise figure at all, so an assumed constant would be one more unmeasured
 * number propagating into the weights of the bundle adjustment.
 *
 * Note what falls out for free. At grazing incidence one camera pixel covers a
 * long, foreshortened strip of sphere, the fringe is averaged along it, and B
 * collapses. So `sigma_phi` grows exactly where the geometry is genuinely least
 * certain, with no explicit obliquity term anywhere in this function.
 */
function decodePhaseAt(
  seq: PhaseSequence,
  pixel: number,
  opts: DecodeOptions,
): PhaseFit {
  const n = seq.steps;
  let sum = 0;
  let sc = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const v = scalarAt(seq.frames[i], pixel, opts.channel);
    const e = (2 * Math.PI * i) / n;
    sum += v;
    sc += v * Math.cos(e);
    ss += v * Math.sin(e);
  }
  const a = sum / n;
  const bc = (2 / n) * sc;
  const bs = (2 / n) * ss;
  const amplitude = Math.hypot(bc, bs);
  let phase = Math.atan2(bs, bc);
  if (phase < 0) phase += 2 * Math.PI;

  let sigmaI = opts.noiseSigma;
  if (n > 3) {
    let ss2 = 0;
    for (let i = 0; i < n; i++) {
      const v = scalarAt(seq.frames[i], pixel, opts.channel);
      const e = (2 * Math.PI * i) / n;
      const model = a + bc * Math.cos(e) + bs * Math.sin(e);
      ss2 += (v - model) * (v - model);
    }
    // Floor at the assumed noise so a noiseless synthetic capture reports a
    // small-but-finite sigma rather than zero, which would be an infinite weight.
    sigmaI = Math.max(Math.sqrt(ss2 / (n - 3)), opts.noiseSigma * 1e-3);
  }

  const sigmaPhase =
    amplitude > 0 ? Math.sqrt(2 / n) * (sigmaI / amplitude) : Number.POSITIVE_INFINITY;
  return { phase, amplitude, sigmaPhase };
}

/**
 * Combine the Gray address and the wrapped phase for one axis into a continuous
 * projector coordinate.
 *
 * The Gray code lands the pixel inside a stride-wide bin; the phase says where
 * inside a fringe it sits. Unwrapping picks the fringe order `k` that puts the
 * phase position nearest the Gray position, and then — this is the part worth
 * keeping — CHECKS it. If the two disagree by an appreciable fraction of a
 * fringe, one of them is wrong and the correspondence is dropped rather than
 * averaged. A wrong fringe order is a whole-period outlier, which is exactly
 * the kind of gross error that a robust loss can absorb but should not have to.
 */
function decodeAxis(
  capture: PatternCapture,
  axis: DecodeAxis,
  pixel: number,
  modulation: number,
  res: number,
  opts: DecodeOptions,
): AxisResult {
  const gray = capture.gray.find((g) => g.axis === axis) ?? null;
  const phase = capture.phase.find((p) => p.axis === axis) ?? null;
  if (!gray && !phase) return FAIL('missing');

  let coarse = NaN;
  let coarseSigma = NaN;
  if (gray) {
    const g = decodeGrayAt(gray, pixel, modulation, opts);
    if (!g.ok) return FAIL('gray');
    // The address names a bin; without phase, the best estimate is its centre
    // and the uncertainty is that of a uniform distribution over the bin.
    coarse = (g.index + 0.5) * gray.stridePx;
    coarseSigma = gray.stridePx / Math.sqrt(12);
  }

  if (!phase) {
    if (coarse < 0 || coarse > res) return FAIL('range');
    return {
      ok: true,
      coord: coarse,
      sigma: Math.max(coarseSigma, opts.minSigmaPx),
      modulation,
      reason: 'ok',
    };
  }

  const fit = decodePhaseAt(phase, pixel, opts);
  if (!(fit.amplitude >= opts.minPhaseModulation * modulation)) return FAIL('phase');

  const frac = (fit.phase / (2 * Math.PI)) * phase.periodPx;
  let coord: number;
  if (gray) {
    const k = Math.round((coarse - frac) / phase.periodPx);
    coord = k * phase.periodPx + frac;
    if (Math.abs(coord - coarse) > opts.unwrapToleranceFrac * phase.periodPx) {
      return FAIL('disagree');
    }
  } else {
    // No Gray sequence: the only unambiguous case is a single fringe spanning
    // the whole raster, where the fringe order is necessarily zero.
    if (phase.periodPx < res) return FAIL('missing');
    coord = frac;
  }

  if (coord < 0 || coord > res) return FAIL('range');

  const sigma = Math.max(
    (phase.periodPx / (2 * Math.PI)) * fit.sigmaPhase,
    opts.minSigmaPx,
  );
  return { ok: true, coord, sigma, modulation: fit.amplitude / modulation, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Capture decode
// ---------------------------------------------------------------------------

export interface DecodeResult {
  correspondences: Correspondence[];
  stats: DecodeStats;
}

/** Decode one camera's view of one projector. */
export function decodeCapture(
  capture: PatternCapture,
  options: Partial<DecodeOptions> = {},
): DecodeResult {
  const opts: DecodeOptions = { ...DEFAULT_DECODE_OPTIONS, ...options };
  const stats = emptyStats();
  const ref = referencePlanes(capture, opts);
  const out: Correspondence[] = [];
  const stride = Math.max(1, Math.floor(opts.pixelStride));

  for (let py = 0; py < ref.height; py += stride) {
    for (let px = 0; px < ref.width; px += stride) {
      const pixel = py * ref.width + px;
      stats.considered++;

      const modulation = ref.white[pixel] - ref.black[pixel];
      if (!(modulation >= opts.minModulation)) {
        stats.rejectedLowModulation++;
        continue;
      }

      const ru = decodeAxis(capture, 'u', pixel, modulation, capture.projectorRes.x, opts);
      const rv = decodeAxis(capture, 'v', pixel, modulation, capture.projectorRes.y, opts);
      if (!ru.ok || !rv.ok) {
        const reason = !ru.ok ? ru.reason : rv.reason;
        if (reason === 'gray') stats.rejectedGrayAmbiguous++;
        else if (reason === 'phase') stats.rejectedPhaseWeak++;
        else if (reason === 'disagree') stats.rejectedDisagreement++;
        else if (reason === 'range') stats.rejectedOutOfRange++;
        else stats.rejectedMissingAxis++;
        continue;
      }

      out.push({
        camera: capture.camera,
        projector: capture.projector,
        // Pixel centres are at half-integers, conventions.ts §I.
        camU: px + 0.5,
        camV: py + 0.5,
        projU: ru.coord,
        projV: rv.coord,
        sigmaU: ru.sigma,
        sigmaV: rv.sigma,
        modulation: Math.min(ru.modulation, rv.modulation),
      });
      stats.accepted++;
    }
  }

  return { correspondences: decimate(out, opts.maxCorrespondences), stats };
}

/**
 * Deterministic uniform decimation.
 *
 * A 12-megapixel phone frame decodes to millions of correspondences, and the
 * bundle adjustment gains nothing from the last factor of a hundred — the
 * normal equations are 100x100 no matter how many rows feed them. Decimation is
 * by a fixed fractional stride rather than by sampling, so the retained set
 * stays spatially uniform (a random subset would clump) and identical between
 * runs.
 */
function decimate(items: Correspondence[], max: number): Correspondence[] {
  if (max <= 0 || items.length <= max) return items;
  const kept: Correspondence[] = [];
  const step = items.length / max;
  for (let i = 0; i < max; i++) kept.push(items[Math.floor(i * step)]);
  return kept;
}

/** Decode every capture, concatenating in input order so the result is deterministic. */
export function decodeAll(
  captures: readonly PatternCapture[],
  options: Partial<DecodeOptions> = {},
): DecodeResult {
  const all: Correspondence[] = [];
  const stats = emptyStats();
  for (const capture of captures) {
    const r = decodeCapture(capture, options);
    for (const c of r.correspondences) all.push(c);
    stats.considered += r.stats.considered;
    stats.accepted += r.stats.accepted;
    stats.rejectedLowModulation += r.stats.rejectedLowModulation;
    stats.rejectedGrayAmbiguous += r.stats.rejectedGrayAmbiguous;
    stats.rejectedPhaseWeak += r.stats.rejectedPhaseWeak;
    stats.rejectedDisagreement += r.stats.rejectedDisagreement;
    stats.rejectedOutOfRange += r.stats.rejectedOutOfRange;
    stats.rejectedMissingAxis += r.stats.rejectedMissingAxis;
  }
  return { correspondences: all, stats };
}
