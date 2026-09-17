// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The caller Phase 3 was missing, exercised end to end.
 *
 * `packages/solver/test/realphotos.test.ts` already runs
 * `linearise -> assembleCapture -> decodeCapture` and has to restate
 * `planFrames`' order by hand, because `boundary-lint` forbids `solver` from
 * importing `bench`. That hand-written copy is the part this file does NOT
 * repeat, and the reason it exists:
 *
 * **`packages/web` can see both sides.** So these tests drive the real
 * {@link manifestFrameRoles} — the actual join between what the emitter plans
 * and what the decoder expects — rather than a restatement of it that agrees
 * with itself. If the emitter's order and the decoder's convention ever drift
 * apart, no test in `solver` can notice. This one can.
 *
 * What it still does not prove is that real photographs decode. The frames here
 * are synthetic, as `realphotos.test.ts` says of its own: flat albedo, constant
 * ambient, no sensor noise, one camera pixel per projector pixel. Phase 3 stays
 * open until a real capture has been through it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PATTERN_PLAN, planFrames, type PatternPlan } from '../../bench/src/patterns.ts';
import type { FrameRole } from '../../solver/src/assemble.ts';
import type { EncodedImage } from '../../solver/src/ingest.ts';
import {
  MANIFEST_VERSION,
  PLAN_LIMITS,
  captureManifest,
  formatManifest,
  manifestFrameRoles,
  parseCaptureManifest,
  type CaptureManifest,
} from '../src/manifest.ts';
import { readCapture, type CaptureRun } from '../src/readback.ts';

const RES = 256;
const BITS = 5;
const STRIDE = RES / Math.pow(2, BITS); // 8 projector pixels
const STEPS = 4;
const PERIOD = STRIDE * 2; // 16 — the even multiple decode.ts requires

const PLAN: PatternPlan = {
  grayBits: BITS,
  phaseSteps: STEPS,
  phasePeriodStrides: 2,
  includeWhiteBlack: true,
};

const ALBEDO = 0.7;
const AMBIENT = 0.05;

function manifest(plan: PatternPlan = PLAN): CaptureManifest {
  return captureManifest(plan, { x: RES, y: RES }, 1, 2, '2026-09-16T00:00:00.000Z');
}

/**
 * The pattern, written from `decode.ts`'s normative header.
 *
 * Deliberately a second implementation rather than a call into `patternfilm.ts`
 * or `grayPatternBit`, for the reason `realphotos.test.ts` gives: a fixture that
 * asks the code under test what it painted can only ever agree with itself.
 */
function emit(role: FrameRole, u: number, v: number): number {
  if (role.kind === 'white') return 1;
  if (role.kind === 'black') return 0;
  const s = role.axis === 'u' ? u : v;
  if (role.kind === 'phase') {
    return 0.5 + 0.5 * Math.cos((2 * Math.PI * s) / PERIOD - (2 * Math.PI * role.index) / STEPS);
  }
  const code = Math.min(Math.pow(2, BITS) - 1, Math.max(0, Math.floor(s / STRIDE)));
  const gray = code ^ (code >>> 1);
  const bit = (gray >>> (BITS - 1 - role.index)) & 1;
  return role.kind === 'grayInverse' ? 1 - bit : bit;
}

/** sRGB encode, IEC 61966-2-1 — the inverse of what `linearise` undoes. */
function srgbEncode(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** One frame as a camera files it: 8-bit sRGB, one camera pixel per projector pixel. */
function shoot(role: FrameRole, gain = 1): EncodedImage {
  const data = new Uint8Array(RES * RES);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const lit = gain * (AMBIENT + ALBEDO * emit(role, x + 0.5, y + 0.5));
      data[y * RES + x] = Math.round(srgbEncode(lit) * 255);
    }
  }
  return { width: RES, height: RES, channels: 1, data, maxValue: 255 };
}

function run(m: CaptureManifest, gain = 1): CaptureRun {
  const roles = manifestFrameRoles(m);
  return {
    camera: 0,
    projector: 0,
    images: roles.map((r) => shoot(r, gain)),
    names: roles.map((_, i) => `IMG_${String(i + 1).padStart(4, '0')}.jpg`),
  };
}

test('the emitter plan and the decoder agree, driven through the real join', () => {
  // The test this file exists for. `manifestFrameRoles` is the only place the
  // emitter's frame order and the assembler's roles meet, and nothing in
  // `packages/solver` is allowed to import the emitter side to check it.
  const m = manifest();
  const result = readCapture([run(m)], m, { kind: 'srgb' });

  assert.equal(result.ok, true, 'a clean synthetic capture should decode');
  if (!result.ok) return;
  assert.ok(
    result.correspondences.length > 1000,
    `expected a dense decode, got ${result.correspondences.length} correspondences`,
  );

  // The capture decodes AND is refused a pose, which is the pair of facts
  // Phase 3 asks to be reported together. One camera cannot separate a
  // projector's distance from its field of view, and `worth.ts` grounds that
  // in a measurement rather than a threshold.
  assert.equal(result.worth.usable, false, 'one camera is degenerate and must be refused');
  assert.match(result.worth.refusal ?? '', /Only 1 camera contributed/);
  assert.match(result.worth.refusal ?? '', /EXPERIMENT-1/, 'the refusal cites what makes it one');
  assert.match(result.worth.summary, /65,536 points decoded/);
});

test('the decoded projector coordinates are the ones that were projected', () => {
  // Plumbing is only proved by the numbers coming out the far end. One camera
  // pixel maps to one projector pixel in this fixture, so a correspondence at
  // camera (x, y) must decode to projector (x, y) within quantisation.
  const m = manifest();
  const result = readCapture([run(m)], m, { kind: 'srgb' });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  let worst = 0;
  for (const c of result.correspondences) {
    worst = Math.max(worst, Math.abs(c.projU - c.camU), Math.abs(c.projV - c.camV));
  }
  // `docs/OPERATOR-PATH.md` records a hundredth of a projector pixel for 8-bit
  // sRGB on this fixture, and the measurement here is 0.0063. The bound is set
  // at a fiftieth: tight enough that a frame landing in the wrong slot fails it
  // by orders of magnitude, loose enough not to be a float-equality test of
  // another package's arithmetic.
  assert.ok(worst < 0.02, `decoded coordinates drifted ${worst.toFixed(4)} projector pixels`);
});

test('a run missing its last photograph is refused, not decoded as a shorter plan', () => {
  // The hazard `assemble.ts` was written to refuse and the reason the manifest
  // carries the PLANNED step count: a four-step phase run that lost a frame,
  // counted rather than checked, decodes 0/90/180 as 0/120/240 and is
  // confidently wrong. Counting what arrived can never catch it.
  const m = manifest();
  const full = run(m);
  const short: CaptureRun = {
    ...full,
    images: full.images.slice(0, -1),
    names: full.names.slice(0, -1),
  };
  const result = readCapture([short], m, { kind: 'srgb' });

  assert.equal(result.ok, false, 'a short run must not produce a worth report');
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]?.stats, null, 'nothing should have reached the decoder');
  assert.ok(
    result.runs[0]?.problems.some((p) => p.includes('photographs') || p.includes('roles')),
    `expected a problem naming the count, got ${JSON.stringify(result.runs[0]?.problems)}`,
  );
});

test('an empty hand-in refuses rather than reporting an empty capture', () => {
  const result = readCapture([], manifest(), { kind: 'srgb' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.refusal, /no photographs/i);
});

test('clipping is reported beside the result rather than used to withhold it', () => {
  // A capture that was overexposed looks, from the decoder's side, exactly like
  // one shot in a bright room. The ingest report is the only thing that
  // separates them, and it is only visible at this layer.
  const m = manifest();
  const result = readCapture([run(m, 1.6)], m, { kind: 'srgb' });
  assert.equal(result.ok, true, 'clipping must not withhold the report');
  if (!result.ok) return;
  const problems = result.runs[0]?.problems ?? [];
  assert.ok(
    problems.some((p) => p.includes("sensor's ceiling")),
    `expected clipping to be named, got ${JSON.stringify(problems)}`,
  );
  assert.ok(
    (result.runs[0]?.worstClippedName ?? '').startsWith('IMG_'),
    'the clipped frame is named so the operator has somewhere to look',
  );
});

/** Mean absolute error between decoded and projected coordinates, in projector pixels. */
function meanCoordError(cs: readonly { projU: number; camU: number; projV: number; camV: number }[]): number {
  if (cs.length === 0) return Infinity;
  let sum = 0;
  for (const c of cs) sum += Math.max(Math.abs(c.projU - c.camU), Math.abs(c.projV - c.camV));
  return sum / cs.length;
}

test('the wrong transfer costs accuracy rather than correspondences', () => {
  // `ingest.ts` makes the transfer a required argument on the grounds that a
  // caller who does not know it "does not have a capture, it has a folder of
  // pictures". That claim is only worth making if being wrong costs something,
  // and the first version of this test asserted the wrong cost: it expected
  // FEWER correspondences and got exactly as many.
  //
  // The reason is in decode.ts's own design. A Gray bit is read as the SIGN of
  // a difference, and sign survives any monotone transfer — so every pixel
  // still decodes. What a wrong transfer damages is the PHASE, which is fitted
  // to the shape of a sinusoid rather than to its ordering, and `ingest.ts`
  // says exactly that: "it works in linear light because a gamma-encoded
  // sinusoid biases the phase estimate".
  //
  // Measured here rather than argued: treating sRGB as linear costs an order of
  // magnitude in decoded position while the count does not move at all. That is
  // the failure worth fearing — not a capture that refuses, but one that
  // returns the same number of confidently misplaced correspondences.
  const m = manifest();
  const shot = run(m);
  const right = readCapture([shot], m, { kind: 'srgb' });
  const wrong = readCapture([shot], m, { kind: 'linear' });
  assert.equal(right.ok, true);
  assert.equal(wrong.ok, true);
  if (!right.ok || !wrong.ok) return;

  assert.equal(
    wrong.correspondences.length,
    right.correspondences.length,
    'the count must NOT be what distinguishes them — that is the point',
  );
  const errRight = meanCoordError(right.correspondences);
  const errWrong = meanCoordError(wrong.correspondences);
  assert.ok(
    errWrong > errRight * 5,
    `treating sRGB as linear should cost real accuracy: ${errWrong.toFixed(4)} px against ` +
      `${errRight.toFixed(4)} px`,
  );
});

test('manifest roles are exactly the emitter order, kind for kind', () => {
  const m = manifest();
  const specs = planFrames(m.plan);
  const roles = manifestFrameRoles(m);
  assert.equal(roles.length, specs.length);
  assert.equal(roles.length, m.framesPerRun);
  for (let i = 0; i < roles.length; i++) {
    assert.equal(roles[i]?.kind, specs[i]?.kind, `frame ${i} kind`);
    assert.equal(roles[i]?.axis, specs[i]?.axis, `frame ${i} axis`);
    assert.equal(roles[i]?.index, specs[i]?.index, `frame ${i} index`);
  }
});

test('a manifest survives the round trip through a file', () => {
  const m = manifest();
  const parsed = parseCaptureManifest(formatManifest(m));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.manifest.plan, m.plan);
  assert.deepEqual(parsed.manifest.projectorRes, m.projectorRes);
  assert.equal(parsed.manifest.projectors, m.projectors);
  assert.equal(parsed.manifest.framesPerRun, m.framesPerRun);
  assert.equal(parsed.manifest.written, m.written);
});

test('the default plan is the one an operator gets, and it round trips', () => {
  // Guards against the manifest quietly only working for this file's fixture.
  const m = captureManifest(DEFAULT_PATTERN_PLAN, { x: 1920, y: 1200 }, 4, 2, '');
  const parsed = parseCaptureManifest(formatManifest(m));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.framesPerRun, 34, 'the documented 34 frames per projector');
});

test('a plan from another version is refused rather than read as this one', () => {
  const m = manifest();
  const older = { ...m, version: MANIFEST_VERSION + 1 };
  const parsed = parseCaptureManifest(JSON.stringify(older));
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems[0]?.includes('version'));
});

test('a hand-edited frame count is refused, because neither side can be trusted', () => {
  const m = manifest();
  const tampered = { ...m, framesPerRun: m.framesPerRun + 1 };
  const parsed = parseCaptureManifest(JSON.stringify(tampered));
  assert.equal(parsed.ok, false);
  assert.ok(
    parsed.problems[0]?.includes('frames per run'),
    `expected the mismatch to be named, got ${JSON.stringify(parsed.problems)}`,
  );
});

test('an odd fringe period is refused, since the cross-check could never fire', () => {
  // decode.ts requires an even multiple of the Gray stride: at 1 every Gray
  // misread displaces the estimate by a whole fringe and the unwrap silently
  // agrees. This is the one plan field where the wrong value disables the
  // capture's own error detection.
  const m = manifest({ ...PLAN, phasePeriodStrides: 3 });
  const parsed = parseCaptureManifest(JSON.stringify(m));
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => p.includes('odd')));
});

test('a file that is not a plan says so instead of throwing', () => {
  for (const text of ['', 'not json at all', '[]', '{"version":1}']) {
    const parsed = parseCaptureManifest(text);
    assert.equal(parsed.ok, false, `"${text}" should be refused`);
    assert.ok(parsed.problems.length > 0, `"${text}" should say why`);
  }
});

test('an out-of-range plan is refused fast, not expanded into an array first', () => {
  // The sharpest of review's findings on this PR, and it was not a lax check
  // but a crash. `parseCaptureManifest` derives `framesPerRun` via `planFrames`,
  // which expands the plan into a real array — so an unbounded `grayBits` spent
  // 21.5 seconds allocating and then threw `Invalid array length`, out of the
  // function whose docblock promises it refuses rather than guesses, inside a
  // promise with no catch. The operator picked a file and the page did nothing.
  //
  // The timing is asserted because the refusal has to happen BEFORE the
  // expansion; a version that checked afterwards would still hang.
  const huge = {
    version: MANIFEST_VERSION,
    plan: { grayBits: 100000000, phaseSteps: 4, phasePeriodStrides: 2, includeWhiteBlack: true },
    projectorRes: { x: 1920, y: 1200 },
    projectors: 4,
  };
  const started = Date.now();
  const parsed = parseCaptureManifest(JSON.stringify(huge));
  const elapsed = Date.now() - started;

  assert.equal(parsed.ok, false, 'an impossible plan must be refused, not built');
  assert.ok(
    parsed.problems.some((p) => p.includes('grayBits')),
    `expected the field to be named, got ${JSON.stringify(parsed.problems)}`,
  );
  assert.ok(elapsed < 250, `refusing took ${elapsed} ms, so it expanded the plan before checking`);
});

test('the plan bounds are the emitter’s own, so the file and the boxes cannot disagree', () => {
  // PLAN_LIMITS is shared with `readPlan`'s clamp. These assertions are against
  // the CONVENTION — emit.html's number boxes say 1-8 and 4-12 — rather than
  // against the constant restating itself.
  assert.deepEqual(PLAN_LIMITS.grayBits, { min: 1, max: 8 });
  assert.deepEqual(PLAN_LIMITS.phaseSteps, { min: 4, max: 12 });

  // Each case is a manifest built from its own plan, NOT an existing one with
  // the plan swapped underneath it: `framesPerRun` is derived from the plan, so
  // patching one field leaves the file self-inconsistent and the refusal would
  // come from the wrong check. The first draft of this test did exactly that
  // and passed for a reason it was not testing.
  const withPlan = (over: Partial<PatternPlan>): string =>
    JSON.stringify(captureManifest({ ...PLAN, ...over }, { x: RES, y: RES }, 1, 2, ''));

  for (const grayBits of [0, 9, -1, 1.5]) {
    assert.equal(parseCaptureManifest(withPlan({ grayBits })).ok, false, `grayBits ${grayBits}`);
  }
  // Three steps is the interesting one: `assembleCapture` refuses under three,
  // and this page cannot emit under four, so the manifest is refused by the
  // tighter of the two rather than left for the assembler to catch later.
  for (const phaseSteps of [0, 1, 2, 3, 13]) {
    assert.equal(parseCaptureManifest(withPlan({ phaseSteps })).ok, false, `phaseSteps ${phaseSteps}`);
  }
  for (const ok of [4, 8, 12]) {
    assert.equal(parseCaptureManifest(withPlan({ phaseSteps: ok })).ok, true, `phaseSteps ${ok}`);
  }
});

test('a NaN or Infinity in the plan is refused rather than propagated', () => {
  // JSON cannot carry them literally, but a hand-rolled file can hold `1e999`,
  // which parses to Infinity. `Number.isInteger` rejects both, and this pins
  // that rather than leaving it to a range comparison that would pass for
  // Infinity if the bound were only a lower one.
  const parsed = parseCaptureManifest(
    '{"version":1,"plan":{"grayBits":1e999,"phaseSteps":4,"phasePeriodStrides":2,' +
      '"includeWhiteBlack":true},"projectorRes":{"x":1920,"y":1200},"projectors":4}',
  );
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => p.includes('grayBits')));
});
