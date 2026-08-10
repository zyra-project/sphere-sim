/**
 * packages/sim — the forward model (component A).
 *
 * Input: an equirectangular image plus a `RigCalibration`. Output: a simulated
 * view of the sphere in a room, the framebuffer SOS would drive, and
 * per-surface-point data.
 *
 * This barrel is the package's public face. It imports `packages/calibration`
 * and nothing else across package lines — see packages/sim/README.md for why
 * that constraint is the whole project rather than a style rule.
 */

export * from './vec.ts';
export * from './geometry.ts';
export * from './optics.ts';
export * from './coverage.ts';
export * from './scene.ts';
export * from './random.ts';
export * from './equirect.ts';
export * from './shading.ts';
export * from './render.ts';
export * from './png.ts';
