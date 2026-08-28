// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * @sphere/meshio — reading a model file into the boundary object's mesh type.
 *
 * IO, and nothing else. It produces `SurfaceMesh` — arrays — and holds no
 * geometry: no intersection, no acceleration structure, no projection. That is
 * not modesty about scope, it is the boundary rule. `tools/boundary-lint.ts` R1
 * lets `packages/sim` and `packages/solver` import `packages/calibration` and
 * nothing else, so this package is unreachable from either model by
 * construction, and `test/boundary.test.ts` asserts it stays that way.
 *
 * The consumers are the packages that already hold both models — `packages/web`
 * and `packages/bench`. They read a file here and hand the arrays to each side,
 * which then builds its own hierarchy and writes its own ray-triangle test. See
 * `packages/calibration/src/mesh.ts` for why that duplication is the point.
 */

export type { GlbOptions } from './glb.ts';
export { readGlb } from './glb.ts';
