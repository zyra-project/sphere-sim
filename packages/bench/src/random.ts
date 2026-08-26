// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The bench's own seeded generator.
 *
 * `packages/sim` has one and `packages/solver` has one, for the reason spelled
 * out in `packages/sim/src/random.ts`: a shared helper package is how the A/B
 * boundary erodes. The bench is allowed to import both sides, so it could
 * legitimately borrow either — and it still keeps its own, for a different
 * reason.
 *
 * The loop protocol in docs/ARCHITECTURE.md says scenarios regenerate with fresh
 * seeds every round, and that a specific scenario must be reproducible exactly
 * for a before/after comparison. That makes the scenario corpus a stable
 * artifact of the bench: seed 1234 must name the same twelve scenarios next
 * month as it does today. If the corpus were generated from the simulator's
 * generator, an unrelated improvement inside `packages/sim` that consumed one
 * extra draw somewhere would silently renumber every scenario in the project's
 * history, and every round-over-round comparison drawn against them would be
 * comparing different rigs. The scenario generator's stream has to belong to
 * whoever owns the corpus.
 *
 * Same construction as the other two — splitmix64 seeding xoshiro128** — because
 * that construction is right, not because the code is shared: adjacent seeds
 * must produce decorrelated streams, and the loop hands out adjacent seeds by
 * construction.
 */

const MASK64 = (1n << 64n) - 1n;

function splitmix64(state: bigint): { value: bigint; next: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { value: z, next };
}

export interface BenchRng {
  nextUint32(): number;
  nextFloat(): number;
  uniform(lo: number, hi: number): number;
  gaussian(): number;
  normal(mean: number, stdDev: number): number;
  /** Uniform integer in `[lo, hi]`, inclusive. */
  int(lo: number, hi: number): number;
  /** Fresh independent generator, labelled. See {@link deriveSeed}. */
  fork(label: string): BenchRng;
}

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Mix a seed with a label into a new seed.
 *
 * Sub-streams are addressed by NAME rather than by draw order. A scenario's
 * camera placement, its misalignment injection, its sensor noise and its
 * pattern rendering each get their own stream from the same scenario seed, so
 * adding a draw to one of them — say, a new degradation parameter — cannot
 * shift any of the others. Without that, every scenario in the corpus changes
 * the first time somebody adds a knob, and the loop's round-over-round
 * comparison quietly stops being a comparison.
 */
export function deriveSeed(seed: number, label: string): number {
  let s = BigInt(Math.floor(seed) >>> 0) & MASK64;
  for (let i = 0; i < label.length; i++) {
    s = (s ^ BigInt(label.charCodeAt(i))) & MASK64;
    s = splitmix64(s).value;
  }
  return Number(s & 0x7fffffffn);
}

export function makeBenchRng(seed: number): BenchRng {
  let sm = BigInt(Math.floor(seed)) & MASK64;
  const s = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    const step = splitmix64(sm);
    sm = step.next;
    s[i] = Number(step.value & 0xffffffffn) >>> 0;
  }
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 0x9e3779b9;

  let hasSpare = false;
  let spare = 0;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl32(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl32(s[3], 11);
    return result >>> 0;
  };

  const nextFloat = (): number => nextUint32() * 2.3283064365386963e-10;

  const gaussian = (): number => {
    // Box-Muller rather than the polar form: the polar form's draw count
    // depends on the values drawn, so the stream position becomes data
    // dependent and a reordered call site changes every later number.
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    const u1 = (nextUint32() + 0.5) * 2.3283064365386963e-10;
    const u2 = (nextUint32() + 0.5) * 2.3283064365386963e-10;
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    spare = r * Math.sin(theta);
    hasSpare = true;
    return r * Math.cos(theta);
  };

  const rng: BenchRng = {
    nextUint32,
    nextFloat,
    uniform: (lo: number, hi: number): number => lo + (hi - lo) * nextFloat(),
    gaussian,
    normal: (mean: number, stdDev: number): number => mean + stdDev * gaussian(),
    int: (lo: number, hi: number): number => lo + Math.floor(nextFloat() * (hi - lo + 1)),
    fork: (label: string): BenchRng => makeBenchRng(deriveSeed(seed, label)),
  };
  return rng;
}
