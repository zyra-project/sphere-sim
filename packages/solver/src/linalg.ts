// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * The solver's own linear algebra.
 *
 * This file duplicates routines that `packages/sim` also needs. That is
 * deliberate and enforced (see packages/sim/README.md and tools/boundary-lint.ts):
 * if the two sides shared so much as a 3x3 multiply, a sign error in the shared
 * copy would cancel out of every recovery score and the bench would report
 * success while both models were wrong about the same thing.
 *
 * Everything here is dense and small. The bundle adjustment's normal equations
 * are at most ~100x100 (4 projectors x 13 params + 8 cameras x 7 params + 1
 * global), so a dense factorisation is the right tool and sparsity would only
 * buy complexity. The per-correspondence work is kept sparse instead, by
 * accumulating only the parameter blocks a correspondence actually touches —
 * see bundle.ts.
 *
 * Determinism: no `Math.random`, no iteration over Maps or Sets in a way that
 * reaches floating-point accumulation, fixed sweep counts in the eigensolver.
 * Two runs with the same inputs produce bit-identical results.
 */

/** Cartesian 3-vector. Structurally compatible with the boundary type's `Vec3`. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Row-major 3x3 matrix: `m[row * 3 + col]`.
 *
 * Row-major because every rotation in conventions.ts §R is written as a product
 * of textbook rotation matrices, and reading `m[0]..m[2]` as the first row keeps
 * the code visually alignable with the document it implements.
 */
export type Mat3 = Float64Array;

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function vDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vNorm(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function vNormalize(a: Vec3): Vec3 {
  const n = vNorm(a);
  // A zero vector has no direction; returning it unchanged lets callers detect
  // the degeneracy by checking the norm rather than by catching an exception in
  // the middle of a Jacobian accumulation.
  if (n === 0) return { x: 0, y: 0, z: 0 };
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}

export function mat3Identity(): Mat3 {
  const m = new Float64Array(9);
  m[0] = 1;
  m[4] = 1;
  m[8] = 1;
  return m;
}

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const m = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return m;
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function mat3Transpose(m: Mat3): Mat3 {
  const t = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) t[i * 3 + j] = m[j * 3 + i];
  return t;
}

/** Column `j` of a row-major 3x3, as a vector. */
export function mat3Column(m: Mat3, j: number): Vec3 {
  return { x: m[j], y: m[3 + j], z: m[6 + j] };
}

export function mat3Det(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

// ---------------------------------------------------------------------------
// Dense symmetric solve
// ---------------------------------------------------------------------------

export interface SymmetricSolve {
  x: Float64Array;
  /** Which factorisation actually produced the answer. Reported for diagnostics. */
  method: 'cholesky' | 'ldlt';
  /**
   * False when the matrix was rank-deficient and the pseudo-solve zeroed one or
   * more directions. The bundle adjustment treats this as "raise the damping and
   * retry" rather than as an error, because a rank-deficient normal matrix in a
   * free-network adjustment usually means the gauge constraint has not bitten yet.
   */
  ok: boolean;
  /** Number of pivots that had to be treated as zero. */
  deficiency: number;
}

/**
 * Cholesky factorisation of a symmetric positive-definite matrix, in place into
 * a fresh lower-triangular array. Returns null if a pivot is not positive, which
 * is the cheap test for "this matrix is not SPD" — cheaper and more reliable
 * than computing eigenvalues.
 */
function choleskyFactor(a: Float64Array, n: number): Float64Array | null {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (!(sum > 0)) return null;
        l[i * n + j] = Math.sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j];
      }
    }
  }
  return l;
}

function choleskySolve(l: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * y[k];
    y[i] = sum / l[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k];
    x[i] = sum / l[i * n + i];
  }
  return x;
}

/**
 * LDL^T with a pivot guard, used when Cholesky reports the matrix is not
 * positive definite.
 *
 * A free-network bundle adjustment has, by construction, a null space (see
 * bundle.ts on gauge freedom). If the gauge constraint is under-weighted or the
 * damping is small, the normal matrix can be numerically semi-definite. Failing
 * hard there would be wrong: the *data* directions are still perfectly
 * conditioned. So near-zero pivots are treated as exactly zero and the
 * corresponding component of the solution is set to zero, which is the
 * minimum-norm (pseudo-inverse) answer along the deficient direction and is
 * exactly the behaviour a minimal-constraint adjustment wants.
 */
function ldltSolve(
  a: Float64Array,
  n: number,
  b: Float64Array,
  pivotTol: number,
): { x: Float64Array; deficiency: number } {
  const l = new Float64Array(n * n);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) l[i * n + i] = 1;

  // Scale the tolerance to the matrix so it means the same thing whether the
  // normal equations are in pixels-squared or metres-squared.
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(a[i * n + i]));
  const tol = pivotTol * (scale > 0 ? scale : 1);

  let deficiency = 0;
  for (let j = 0; j < n; j++) {
    let dj = a[j * n + j];
    for (let k = 0; k < j; k++) dj -= l[j * n + k] * l[j * n + k] * d[k];
    if (Math.abs(dj) < tol) {
      d[j] = 0;
      deficiency++;
      for (let i = j + 1; i < n; i++) l[i * n + j] = 0;
      continue;
    }
    d[j] = dj;
    for (let i = j + 1; i < n; i++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k] * d[k];
      l[i * n + j] = sum / dj;
    }
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * y[k];
    y[i] = sum;
  }
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = d[i] === 0 ? 0 : y[i] / d[i];
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k];
    x[i] = sum;
  }
  return { x, deficiency };
}

/**
 * Solve `A x = b` for symmetric `A`, preferring Cholesky and falling back to a
 * pivot-guarded LDL^T. `a` is row-major `n x n` and is not modified.
 */
export function solveSymmetric(
  a: Float64Array,
  n: number,
  b: Float64Array,
  pivotTol = 1e-14,
): SymmetricSolve {
  const l = choleskyFactor(a, n);
  if (l !== null) {
    return { x: choleskySolve(l, n, b), method: 'cholesky', ok: true, deficiency: 0 };
  }
  const r = ldltSolve(a, n, b, pivotTol);
  return { x: r.x, method: 'ldlt', ok: r.deficiency === 0, deficiency: r.deficiency };
}

// ---------------------------------------------------------------------------
// Symmetric eigen decomposition (cyclic Jacobi)
// ---------------------------------------------------------------------------

export interface EigenResult {
  /** Eigenvalues, ascending. */
  values: Float64Array;
  /** Row-major `n x n`; column `j` is the unit eigenvector for `values[j]`. */
  vectors: Float64Array;
}

/**
 * Cyclic Jacobi eigen decomposition of a symmetric matrix.
 *
 * Chosen over a QR/Householder path because it is short, unconditionally stable
 * for symmetric input, and — the property that matters here — completely
 * deterministic: a fixed number of sweeps over a fixed (p, q) order, no pivoting
 * decisions that could depend on tie-breaking. The solver needs it for two
 * things: the 3x3 polar decomposition that orthogonalises a DLT rotation block,
 * and the 12x12 null-vector extraction inside the DLT pose bootstrap.
 */
export function jacobiEigenSymmetric(
  input: Float64Array,
  n: number,
  maxSweeps = 60,
): EigenResult {
  const a = Float64Array.from(input);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    }
    if (off <= 1e-30) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (apq === 0) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        // Standard Jacobi rotation; the `t` form below avoids cancellation when
        // theta is large, which is the usual failure mode of the naive formula.
        const theta = (aqq - app) / (2 * apq);
        const t =
          theta >= 0
            ? 1 / (theta + Math.sqrt(1 + theta * theta))
            : -1 / (-theta + Math.sqrt(1 + theta * theta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];

  // Sort ascending. The index sort is by (value, index) so equal eigenvalues
  // keep a stable, input-order-determined column ordering — otherwise a
  // degenerate matrix could produce different eigenvector signs between runs.
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((i, j) => (values[i] === values[j] ? i - j : values[i] - values[j]));

  const sortedValues = new Float64Array(n);
  const sortedVectors = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const src = order[j];
    sortedValues[j] = values[src];
    // Fix the sign so the first structurally non-zero component is positive.
    // Jacobi's sign is arbitrary, and an arbitrary sign that varies between runs
    // would break the determinism the bench depends on.
    let sign = 1;
    for (let i = 0; i < n; i++) {
      const c = v[i * n + src];
      if (Math.abs(c) > 1e-12) {
        sign = c < 0 ? -1 : 1;
        break;
      }
    }
    for (let i = 0; i < n; i++) sortedVectors[i * n + j] = sign * v[i * n + src];
  }
  return { values: sortedValues, vectors: sortedVectors };
}

/**
 * Nearest rotation matrix to `m` in the Frobenius sense — the rotation factor of
 * the polar decomposition `m = R S`.
 *
 * Used after the DLT pose bootstrap, whose 3x3 block is only approximately
 * orthonormal because the linear solve knows nothing about the constraint. The
 * computation is `R = m (m^T m)^(-1/2)` via the symmetric eigen decomposition of
 * `m^T m`; if that lands on a reflection (det < 0, which happens when the DLT
 * null vector came out with the wrong overall sign convention) the smallest
 * singular direction is flipped, which is the minimal change that restores a
 * proper rotation.
 */
export function nearestRotation(m: Mat3): Mat3 {
  const mt = mat3Transpose(m);
  const mtm = mat3Multiply(mt, m);
  const { values, vectors } = jacobiEigenSymmetric(mtm, 3);

  const inv = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        const lambda = values[k];
        if (lambda <= 1e-24) continue;
        sum += (vectors[i * 3 + k] * vectors[j * 3 + k]) / Math.sqrt(lambda);
      }
      inv[i * 3 + j] = sum;
    }
  }
  let r = mat3Multiply(m, inv);
  if (mat3Det(r) < 0) {
    // Flip the direction with the smallest singular value: eigenvalues came back
    // ascending, so that is column 0.
    const flip = new Float64Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) {
          const lambda = values[k];
          if (lambda <= 1e-24) continue;
          const sign = k === 0 ? -1 : 1;
          sum += (sign * vectors[i * 3 + k] * vectors[j * 3 + k]) / Math.sqrt(lambda);
        }
        flip[i * 3 + j] = sum;
      }
    }
    r = mat3Multiply(m, flip);
  }
  return r;
}

/**
 * The rotation minimising `sum |R p_i - q_i|^2`. Kabsch, with the rank-deficient
 * case handled properly.
 *
 * `nearestRotation` would do for a generic point cloud, but not for this one.
 * The reference layout the solver aligns against is PARAMETERS.md §2's rig:
 * four projectors at the same height, hence exactly COPLANAR. That makes the
 * cross-covariance `H = sum p q^T` rank 2, its polar decomposition undefined,
 * and `nearestRotation` returns a rank-2 matrix that is not a rotation at all —
 * silently, and with a plausible-looking magnitude. Four coplanar points do
 * determine a rotation (up to a reflection that `det = +1` resolves), so the
 * information is there; it just needs the SVD form rather than the polar form.
 *
 * Maximising `tr(R H)` over rotations with `H = U S V^T` gives `R = V Z U^T`,
 * where `Z` is the identity with its entry for the SMALLEST singular value set
 * to `det(U) det(V)` — that is the reflection correction, placed where it costs
 * least. When a singular value is zero its left factor is undefined and is
 * completed by a cross product, which is exactly the coplanar case.
 */
export function kabschRotation(from: readonly Vec3[], to: readonly Vec3[]): Mat3 {
  const n = Math.min(from.length, to.length);
  if (n < 2) return mat3Identity();

  // H = sum p q^T, row-major: h[i*3+j] = p_i q_j.
  const h = new Float64Array(9);
  for (let k = 0; k < n; k++) {
    const p = from[k];
    const q = to[k];
    const pv = [p.x, p.y, p.z];
    const qv = [q.x, q.y, q.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) h[i * 3 + j] += pv[i] * qv[j];
  }

  const hth = mat3Multiply(mat3Transpose(h), h);
  const { values, vectors } = jacobiEigenSymmetric(hth, 3);
  const v = Float64Array.from(vectors);
  // Make V a proper rotation so the reflection bookkeeping below has one place
  // to happen rather than two.
  if (mat3Det(v) < 0) for (let i = 0; i < 3; i++) v[i * 3] = -v[i * 3];

  const scale = Math.max(values[2], 1e-300);
  const u = new Float64Array(9);
  const defined = [false, false, false];
  for (let j = 0; j < 3; j++) {
    const s = Math.sqrt(Math.max(0, values[j]));
    if (s * s <= 1e-12 * scale) continue;
    const vj = { x: v[j], y: v[3 + j], z: v[6 + j] };
    const hv = mat3MulVec(h, vj);
    u[j] = hv.x / s;
    u[3 + j] = hv.y / s;
    u[6 + j] = hv.z / s;
    defined[j] = true;
  }

  // Eigenvalues come back ascending, so index 0 is the degenerate direction in
  // the coplanar case. Complete it from the other two.
  if (!defined[0] && defined[1] && defined[2]) {
    const u1 = { x: u[1], y: u[4], z: u[7] };
    const u2 = { x: u[2], y: u[5], z: u[8] };
    const c = vCross(u1, u2);
    u[0] = c.x;
    u[3] = c.y;
    u[6] = c.z;
    defined[0] = true;
  }
  if (!defined[0] || !defined[1] || !defined[2]) return mat3Identity();

  const z = mat3Identity();
  z[0] = mat3Det(u) * mat3Det(v) < 0 ? -1 : 1;
  return mat3Multiply(mat3Multiply(v, z), mat3Transpose(u));
}

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * A seeded pseudo-random generator.
 *
 * The solver uses randomness in exactly one place — RANSAC sample selection in
 * the pose bootstrap — and the bench requires that two runs with the same seed
 * produce byte-identical output. `Math.random` is therefore banned outright.
 * This is `mulberry32`: 32-bit state, no BigInt, passes the small-scale
 * statistical tests that matter for choosing minimal sample sets, and is fully
 * reproducible across engines because every operation is `Math.imul` or a
 * 32-bit shift.
 */
export interface Rng {
  nextUint32(): number;
  /** Uniform in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Standard normal, Box-Muller with a cached spare. */
  nextGaussian(): number;
}

export function createRng(seed: number): Rng {
  let state = seed | 0;
  let spare = 0;
  let hasSpare = false;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };

  const nextFloat = (): number => nextUint32() / 4294967296;

  return {
    nextUint32,
    nextFloat,
    nextInt: (maxExclusive: number): number => {
      if (maxExclusive <= 0) return 0;
      return Math.min(maxExclusive - 1, Math.floor(nextFloat() * maxExclusive));
    },
    nextGaussian: (): number => {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      // Reject u === 0 so the log never sees zero; the loop terminates with
      // probability 1 and, being seeded, deterministically.
      let u = 0;
      while (u === 0) u = nextFloat();
      const v = nextFloat();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      hasSpare = true;
      return mag * Math.cos(2 * Math.PI * v);
    },
  };
}

/** Median of a copy of `values`. Sorts a copy so the caller's array is untouched. */
export function median(values: readonly number[] | Float64Array): number {
  const n = values.length;
  if (n === 0) return 0;
  const copy = Float64Array.from(values);
  copy.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}
