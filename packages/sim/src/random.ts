/**
 * Seeded pseudo-randomness — the forward model's OWN copy.
 *
 * `packages/solver` gets its own, deliberately. A shared PRNG package looks like
 * the most harmless imaginable piece of common code, and it is exactly the wedge
 * described in tools/boundary-lint.ts: today it holds a PRNG, next month
 * somebody adds a small matrix helper next to it because that is where the
 * shared utilities live, and then the solver is inverting the simulator's own
 * arithmetic. So: no shared helper package, ever, for anything.
 *
 * Requirements this has to meet, from packages/sim/README.md:
 *
 *   - Every computation is a pure function of its inputs plus an explicit seed.
 *   - Two runs with the same seed produce byte-identical output.
 *   - No `Math.random`, no `Date.now`.
 *
 * splitmix64 seeds xoshiro128** because a bad seeding step is the classic way to
 * get correlated streams from adjacent seeds — and the bench sweeps adjacent
 * seeds by construction ("regenerate scenarios with fresh random seeds every
 * round"). splitmix64 decorrelates them; xoshiro128** then supplies a
 * well-mixed 32-bit stream cheaply.
 */

const MASK64 = (1n << 64n) - 1n;

/** One splitmix64 step. Used only for seeding. */
function splitmix64(state: bigint): { value: bigint; next: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { value: z, next };
}

/**
 * xoshiro128** — 32-bit state, 2^128 period, passes the usual statistical
 * batteries. State is four uint32s held in a Uint32Array so the arithmetic stays
 * in the integer domain and cannot pick up a float rounding difference between
 * runs.
 */
export interface Rng {
  /** Next uint32. */
  nextUint32(): number;
  /** Next float in [0, 1). */
  nextFloat(): number;
  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number;
  /** Standard normal, mean 0 and standard deviation 1. */
  gaussian(): number;
  /** Normal with the given mean and standard deviation. */
  normal(mean: number, stdDev: number): number;
}

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Build a generator from an integer seed.
 *
 * The seed is run through splitmix64 four times; taking the low and high halves
 * of two 64-bit outputs would work too, but four independent draws is easier to
 * reason about and the cost is paid once per run.
 */
export function makeRng(seed: number): Rng {
  let sm = BigInt(Math.floor(seed)) & MASK64;
  const s = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    const step = splitmix64(sm);
    sm = step.next;
    s[i] = Number(step.value & 0xffffffffn) >>> 0;
  }
  // An all-zero state is a fixed point of xoshiro. Unreachable from splitmix64
  // in practice, but the check costs nothing and the failure would be silent.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 0x9e3779b9;

  let hasSpare = false;
  let spare = 0;

  const nextUint32 = (): number => {
    const result = (Math.imul(rotl32(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0) as number;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl32(s[3], 11);
    return result >>> 0;
  };

  const nextFloat = (): number => nextUint32() * 2.3283064365386963e-10; // 2^-32

  return {
    nextUint32,
    nextFloat,
    uniform(lo: number, hi: number): number {
      return lo + (hi - lo) * nextFloat();
    },
    gaussian(): number {
      // Box-Muller. The polar (rejection) form is marginally faster but its
      // number of draws depends on the values drawn, which makes the stream
      // position depend on the data — a determinism hazard the moment anyone
      // reorders a call site. This form consumes exactly two uint32s per pair,
      // always.
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      // Nudge off zero: log(0) is -Infinity and one NaN contaminates a whole rig.
      const u1 = (nextUint32() + 0.5) * 2.3283064365386963e-10;
      const u2 = (nextUint32() + 0.5) * 2.3283064365386963e-10;
      const r = Math.sqrt(-2 * Math.log(u1));
      const theta = 2 * Math.PI * u2;
      spare = r * Math.sin(theta);
      hasSpare = true;
      return r * Math.cos(theta);
    },
    normal(mean: number, stdDev: number): number {
      return mean + stdDev * this.gaussian();
    },
  };
}

/**
 * A stateless integer hash, for turning a coordinate into a deterministic
 * "random" value without carrying a stream around.
 *
 * The tracer needs per-pixel sample offsets that are identical between runs but
 * different between pixels. Threading a stateful generator through the pixel
 * loop would make the result depend on iteration order — and therefore on any
 * future decision to render in tiles or in parallel. A hash of the coordinates
 * has no such dependency: the pixel at (17, 43) gets the same offsets no matter
 * when or whether its neighbours were rendered.
 *
 * This is the finalizer from MurmurHash3, which is cheap and mixes every input
 * bit into every output bit.
 */
export function hashInt(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash several integers together into a float in [0, 1). */
export function hash01(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    h = (hashInt(h ^ (v | 0)) + 0x9e3779b9) >>> 0;
  }
  return hashInt(h) * 2.3283064365386963e-10;
}

/**
 * Van der Corput radical inverse in the given base — the building block of the
 * Halton sequence used for supersampling.
 *
 * Halton rather than random jitter because the whole render must be a pure
 * function of `(calibration, scene, seed)`: a low-discrepancy set gives better
 * edge antialiasing per sample than white noise anyway, and it does so without
 * a stream whose position depends on how many pixels came first.
 *
 * The two guards are not defensive noise. `base === 1` leaves `i` unchanged on
 * every pass and hangs the render forever with no error and no frame — the
 * worst failure mode a pure function can have, because it looks like slowness.
 * A fractional index is quieter and worse: it returns a number, so the sequence
 * silently stops being the low-discrepancy set the antialiasing assumes.
 */
export function radicalInverse(base: number, index: number): number {
  if (!Number.isInteger(base) || base < 2) {
    throw new RangeError(`radicalInverse needs an integer base of at least 2, got ${base}`);
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`radicalInverse needs a non-negative integer index, got ${index}`);
  }
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * f;
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}
