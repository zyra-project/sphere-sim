/**
 * packages/bench — the scorer.
 *
 * The only package that imports BOTH `packages/sim` and `packages/solver`.
 * docs/ARCHITECTURE.md explains why that is fine and necessary: something has to
 * hold the ground truth in one hand and the recovered calibration in the other.
 * What matters is that neither model can reach the other THROUGH it — `sim`
 * never imports `bench`, `solver` never imports `bench`, so there is no path,
 * and `tools/boundary-lint.ts` fails the build if one appears.
 *
 * Entry points:
 *   - `cli.ts`  — the headless bench. What CI runs and what critics read.
 *   - `loop.ts` — the Phase 1 round runner.
 */

export * from './random.ts';
export * from './camera.ts';
export * from './patterns.ts';
export * from './capture.ts';
export * from './score.ts';
export * from './scenarios.ts';
export * from './views.ts';
export * from './run.ts';
export * from './results.ts';
export * from './attribute.ts';
