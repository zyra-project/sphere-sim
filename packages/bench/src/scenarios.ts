/**
 * Seeded scenario generation.
 *
 * docs/ARCHITECTURE.md sets the rule this file exists to satisfy: "Scenarios
 * regenerate with fresh seeds every round. A piece that improves on round n's
 * seeds and regresses on round n+1's did not improve; it overfit." And the other
 * half of the rule, which is what makes the first half usable: a specific
 * scenario has to be reproducible exactly, or the loop's before/after pair is
 * comparing two different rigs and calling the difference progress.
 *
 * Both hold here because the seed is an explicit input and everything below is a
 * pure function of it. `generateScenarios(1234, 6)` names the same six rigs
 * today and next month; `loop.ts` hands a different root seed every round.
 *
 * ## Archetypes, and why the corpus is not simply random
 *
 * A corpus of uniformly random scenarios spends most of its samples in the
 * middle of the parameter space and covers the edges by luck. The edges are
 * where the interesting failures are, and several of them are named in the
 * documentation: PARAMETERS.md §2's two- and three-projector installs, its
 * unresolved `d_proj` conflict, §5's ambient range, §1's `h_center` note, and
 * the camera-count sweep the experiment plan asks for. So the corpus is a fixed
 * ordered list of archetypes, each pinning the conditions that make it the case
 * it is, with the rest drawn from the seed.
 *
 * Two consequences worth stating. Scenario 0 is always the canary — zero
 * injected misalignment, noiseless, ambient off — because a bench whose
 * end-to-end path has quietly broken should fail loudly on the first scenario
 * rather than produce twelve plausible-looking failures. And a run of six
 * scenarios (what CI does) always covers the same first six archetypes, so CI's
 * verdict is comparable across commits even though its numbers are not.
 *
 * Asking for more scenarios than there are archetypes cycles the list with
 * fresh seeds, which is what a long round should do: the same twelve questions
 * asked of different rigs.
 */

import type { BlendCalibration } from '../../calibration/src/index.ts';
import type { MisalignmentMagnitudes } from '../../sim/src/scene.ts';
import { DEFAULT_MISALIGNMENT, defaultSlotsFor } from '../../sim/src/scene.ts';
import type { MaskInterpretation } from '../../sim/src/coverage.ts';
import type { CameraPlacementOptions, FrameClock, HandheldMotion } from './camera.ts';
import { DEFAULT_CLOCK, DEFAULT_HANDHELD } from './camera.ts';
import type { RoomSpill, SensorModel } from './capture.ts';
import { DEFAULT_SENSOR } from './capture.ts';
import type { PatternPlan } from './patterns.ts';
import { DEFAULT_PATTERN_PLAN } from './patterns.ts';
import { deriveSeed, makeBenchRng } from './random.ts';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Wall-clock presets.
 *
 * The loop runs many rounds, so the default has to finish in a couple of
 * minutes on four cores. What that budget buys is almost entirely camera
 * resolution: the capture renders `cameras x projectors x frames` images and
 * every one of them is a full pixel loop, so halving the camera's linear
 * resolution quarters the dominant cost.
 *
 * The resolution is a real modelling parameter and not a fudge factor. A
 * 320x240 camera 2.6 m from a 1.7 m sphere resolves the surface at about 8.6 mm
 * per pixel, which is coarse — coarser than a phone, and the recovered numbers
 * are correspondingly pessimistic. `--thorough` at 640x480 is the honest
 * comparison for "does a phone suffice"; `--quick` at 224x168 is for checking
 * that the plumbing works, and its numbers should not be quoted.
 */
export interface BenchPreset {
  name: 'quick' | 'default' | 'thorough';
  scenarioCount: number;
  cameraResX: number;
  cameraResY: number;
  /** Scales every geometric metric's sampling density. */
  metricDensityScale: number;
  /** Run the metrics' own convergence checks. Roughly a 40% cost. */
  metricConvergence: boolean;
  /** Cap on correspondences kept per (camera, projector) pair. */
  maxCorrespondencesPerPair: number;
  /** Minimum camera pixels a Gray stride must span. See `grayBitsForCamera`. */
  minCameraPixelsPerStride: number;
  /** Run the counterfactual attribution for failing gates. */
  attributeFailures: boolean;
  /** Pixels on a side for the artifact renders. */
  renderSize: number;
}

export const PRESETS: Record<BenchPreset['name'], BenchPreset> = {
  quick: {
    name: 'quick',
    scenarioCount: 3,
    cameraResX: 224,
    cameraResY: 168,
    metricDensityScale: 0.25,
    metricConvergence: false,
    maxCorrespondencesPerPair: 900,
    minCameraPixelsPerStride: 4,
    attributeFailures: false,
    renderSize: 256,
  },
  default: {
    name: 'default',
    scenarioCount: 6,
    cameraResX: 320,
    cameraResY: 240,
    metricDensityScale: 1,
    metricConvergence: true,
    maxCorrespondencesPerPair: 1500,
    minCameraPixelsPerStride: 4,
    attributeFailures: true,
    renderSize: 384,
  },
  thorough: {
    name: 'thorough',
    scenarioCount: 12,
    cameraResX: 640,
    cameraResY: 480,
    metricDensityScale: 1,
    metricConvergence: true,
    maxCorrespondencesPerPair: 2500,
    minCameraPixelsPerStride: 4,
    attributeFailures: true,
    renderSize: 512,
  },
};

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

export interface DegradationSettings {
  /** §5 `E_amb`, relative. Nominal 0.04, stated range 0.01-0.15. */
  ambient: number;
  /** null renders a noiseless sensor. A canary, never a claim about a camera. */
  sensor: SensorModel | null;
  /** null holds the camera perfectly still. See camera.ts. */
  handheld: HandheldMotion | null;
  clock: FrameClock;
  /**
   * The room the light that misses the sphere lands on. `null` — the default,
   * and every archetype — is the old behaviour. See `capture.ts`'s
   * {@link RoomSpill}: nothing here is bundled, so this is switchable on its own
   * exactly as ambient, the sensor and the motion are.
   */
  roomSpill: RoomSpill | null;
}

export interface Scenario {
  index: number;
  /** Stable within a run, and printed in every artifact filename. */
  id: string;
  archetype: string;
  /** One sentence: what this scenario is FOR. */
  question: string;
  seed: number;

  // --- the rig ---
  projectorCount: number;
  slots: number[];
  /** §2 `d_proj`. CONFLICTED — 5.18 from the manual, 5.50-6.14 from the floor plan. */
  distanceM: number;
  projectorHeightM: number;
  centerHeightM: number;
  projectorResX: number;
  projectorResY: number;
  blend: Partial<BlendCalibration>;
  maskInterpretation: MaskInterpretation;
  /** Scales every entry of `misalignment`. 0 is the perfectly built rig. */
  misalignmentScale: number;
  misalignment: Required<MisalignmentMagnitudes>;

  // --- the measurement apparatus ---
  cameras: CameraPlacementOptions;
  /** How wrong the operator's guess at each tripod position is. */
  cameraNominalPositionErrorM: number;
  cameraNominalAngleErrorDeg: number;
  degradation: DegradationSettings;
  pattern: PatternPlan;
  /** PARAMETERS.md §8 item 1: floor to each projector lens. 0 = none measured. */
  floorReferenceCount: number;
  floorSigmaM: number;
  /**
   * Whether `fovHDeg` is a free parameter.
   *
   * PARAMETERS.md §3.1 classes `fov_h` SOLVE, which argues for free. It also
   * classes the throw ratio `T` it is derived from as CFG, "read from a
   * hardware spec sheet", which argues for held — and `packages/solver`'s README
   * measures the consequence: a long-throw lens sees the sphere subtend 19
   * degrees, so field of view and distance are nearly degenerate and decode
   * noise maps almost entirely into radial position error when the field is
   * free. The bench runs both rather than picking, because which is right is a
   * measurement and not an opinion.
   */
  freeFov: boolean;
}

interface Archetype {
  name: string;
  question: string;
  /**
   * Draw this archetype's seed from another archetype's, so the two differ in
   * exactly the knob under test and nothing else.
   *
   * Without it, `fov-held` and `two-cameras` would be two different rigs
   * photographed by two different camera sets under two different noise draws,
   * and the difference between their scores would be a difference between
   * scenarios rather than a measurement of the knob. With it they are the same
   * rig, the same cameras, the same photons — a paired comparison, which is the
   * only kind that answers "how much does holding the field of view buy".
   */
  pairWith?: string;
  apply(s: Scenario, rng: ReturnType<typeof makeBenchRng>): void;
}

const NO_SENSOR = null;

/**
 * The corpus.
 *
 * Order is part of the interface: CI runs the first six and compares across
 * commits. Adding an archetype in the middle renumbers everything after it and
 * makes historical comparisons meaningless, so new ones go on the end.
 */
const ARCHETYPES: Archetype[] = [
  {
    name: 'clean',
    question:
      'Is the end-to-end path wired correctly? Zero injected misalignment, no ambient, no sensor noise, a static camera. Anything but a near-zero recovery here is an apparatus fault, not a solver result.',
    apply(s): void {
      s.misalignmentScale = 0;
      s.degradation.ambient = 0;
      s.degradation.sensor = NO_SENSOR;
      s.degradation.handheld = null;
      s.cameras.count = 3;
    },
  },
  {
    name: 'nominal',
    question:
      'What does a well-built rig in a normally-lit room recover to? PARAMETERS.md §2 mount tolerances, §5 nominal ambient, a real sensor, a tripod.',
    apply(s): void {
      s.degradation.handheld = null;
      s.cameras.count = 3;
    },
  },
  {
    name: 'sensor-noise',
    question:
      'How much does photon shot noise alone cost? Ambient held at the §5 nominal, camera static; only the sensor is degraded relative to `nominal`.',
    apply(s, rng): void {
      s.degradation.handheld = null;
      s.degradation.sensor = {
        ...DEFAULT_SENSOR,
        // A shorter exposure: fewer electrons per unit radiance, so more shot
        // noise. Two stops down from the default is the difference between a
        // tripod exposure and one somebody could hold.
        electronsPerUnitRadiance: 1500,
        readNoiseElectrons: 4,
      };
      s.cameras.count = 3;
      s.distanceM = 5.18 + rng.uniform(-0.05, 0.05);
    },
  },
  {
    name: 'high-ambient',
    question:
      'What does the top of §5\'s ambient range cost? E_amb = 0.15, the value NOAA\'s own note implies a typical site sits nearer than their facility does.',
    apply(s): void {
      s.degradation.ambient = 0.15;
      s.degradation.handheld = null;
      s.cameras.count = 3;
    },
  },
  {
    name: 'handheld',
    question:
      'What do a rolling shutter and a handheld phone cost? The camera drifts between frames and during each frame\'s readout; everything else matches `nominal`.',
    apply(s): void {
      s.degradation.handheld = { ...DEFAULT_HANDHELD };
      s.degradation.clock = { ...DEFAULT_CLOCK, rollingShutter: true };
      s.cameras.count = 3;
    },
  },
  {
    name: 'two-cameras',
    question:
      'Is two photographs enough? packages/solver/README.md calls two cameras under heavy noise "close to the edge of what the bootstrap handles". All three degradations on at once.',
    apply(s): void {
      s.cameras.count = 2;
      s.degradation.ambient = 0.12;
      s.degradation.handheld = { ...DEFAULT_HANDHELD };
    },
  },
  {
    name: 'six-cameras',
    question:
      'How much does the sixth photograph buy over the third? Same degradations as `two-cameras`, so the three form a camera-count series.',
    apply(s): void {
      s.cameras.count = 6;
      s.degradation.ambient = 0.12;
      s.degradation.handheld = { ...DEFAULT_HANDHELD };
    },
  },
  {
    name: 'three-projectors',
    question:
      'Does a three-projector install (PARAMETERS.md §2, "quadrants go dark") recover? One quadrant has no projector at all and one seam is missing.',
    apply(s): void {
      s.projectorCount = 3;
      s.slots = defaultSlotsFor(3);
      s.cameras.count = 4;
    },
  },
  {
    name: 'two-projectors',
    question:
      'Does the antipodal two-projector install recover? docs/AMENDMENTS.md A-06: opposed mounts leave 16.7% of the sphere dark, adjacent ones 33.8%, and §2 does not say which a site uses.',
    apply(s): void {
      s.projectorCount = 2;
      s.slots = defaultSlotsFor(2);
      s.cameras.count = 4;
    },
  },
  {
    name: 'long-throw',
    question:
      'Does the bootstrap find the far end of §2\'s unresolved d_proj conflict? Truth is the floor plan\'s 6.14 m while the operator hands over the alignment manual\'s 5.18 m.',
    apply(s, rng): void {
      s.distanceM = 6.14 + rng.uniform(-0.03, 0.03);
      s.cameras.count = 3;
    },
  },
  {
    name: 'no-floor-reference',
    question:
      'What happens to h_center with nothing measuring the floor? PARAMETERS.md §1 makes sub-centimetre h_center recovery a headline claim, and nothing in a structured-light capture sees the floor.',
    apply(s): void {
      s.floorReferenceCount = 0;
      s.cameras.count = 3;
    },
  },
  {
    name: 'fov-held',
    // Same seed as `two-cameras`, so this is the SAME rig, the same cameras and
    // the same photons with one parameter held. Anything else would be
    // comparing two scenarios and calling it a measurement.
    pairWith: 'two-cameras',
    question:
      'How much of the position error is the field-of-view/distance degeneracy? The same rig and the same capture as `two-cameras`, with fovHDeg held at the spec-sheet nominal that §3.1 classes CFG.',
    apply(s): void {
      s.freeFov = false;
      s.cameras.count = 2;
      s.degradation.ambient = 0.12;
      s.degradation.handheld = { ...DEFAULT_HANDHELD };
    },
  },
];

export const ARCHETYPE_NAMES: string[] = ARCHETYPES.map((a) => a.name);

/**
 * Build one scenario.
 *
 * The base is drawn from the seed, then the archetype pins whatever makes it
 * that archetype. That order matters: the archetype must win, or a scenario
 * named `clean` could arrive with injected misalignment on a bad draw and the
 * canary would stop being a canary.
 */
export function makeScenario(rootSeed: number, index: number, preset: BenchPreset): Scenario {
  const slot = index % ARCHETYPES.length;
  const archetype = ARCHETYPES[slot];
  // The cycle number enters the seed, so scenario 12 is archetype 0 asked of a
  // different rig rather than the same rig twice.
  //
  // A paired archetype borrows its partner's seed from the SAME cycle, so the
  // pairing survives `--scenarios 24` instead of silently pairing round one's
  // rig against round two's.
  let seedIndex = index;
  let seedName = archetype.name;
  if (archetype.pairWith !== undefined) {
    const partner = ARCHETYPES.findIndex((a) => a.name === archetype.pairWith);
    if (partner >= 0) {
      seedIndex = index - (slot - partner);
      seedName = ARCHETYPES[partner].name;
    }
  }
  const seed = deriveSeed(rootSeed, `scenario:${seedIndex}:${seedName}`);
  const rng = makeBenchRng(seed).fork('inputs');

  const scenario: Scenario = {
    index,
    id: `s${String(index).padStart(2, '0')}-${archetype.name}`,
    archetype: archetype.name,
    question: archetype.question,
    seed,

    projectorCount: 4,
    slots: defaultSlotsFor(4),
    // §2's conflict spans 5.18 (alignment manual) to 5.50-6.14 (floor plan).
    // The default corpus draws from the manual's end with a few centimetres of
    // scatter; `long-throw` pins the other end explicitly.
    distanceM: 5.18 + rng.uniform(-0.06, 0.06),
    projectorHeightM: 2.1844 + rng.normal(0, 0.02),
    centerHeightM: 2.1844,
    projectorResX: 1920,
    projectorResY: 1080,
    blend: {},
    maskInterpretation: 'latitude',
    misalignmentScale: 1,
    misalignment: { ...DEFAULT_MISALIGNMENT },

    cameras: {
      count: 3,
      // §6 bounds the viewing distance at 2.0-3.5 m, the low end by the guard
      // rail. An operator photographing the sphere stands where a viewer stands.
      distanceM: rng.uniform(2.2, 3.0),
      heightM: rng.uniform(1.35, 1.7),
      resX: preset.cameraResX,
      resY: preset.cameraResY,
      fovHDeg: 62,
      k1: -0.09,
      k2: 0.02,
      positionJitterM: 0.02,
      aimJitterDeg: 2.0,
      rollJitterDeg: 1.5,
      heightSpreadM: 0.35,
    },
    // The operator's guess at where the tripod stood: right side of the sphere,
    // wrong distance and aim. `packages/solver`'s own tests use the same
    // magnitudes, which is where these came from.
    cameraNominalPositionErrorM: 0.25,
    cameraNominalAngleErrorDeg: 3.0,

    degradation: {
      ambient: 0.04,
      sensor: { ...DEFAULT_SENSOR },
      handheld: { ...DEFAULT_HANDHELD },
      clock: { ...DEFAULT_CLOCK },
      // Off, here and in every archetype. Every published number in
      // bench-results.json was produced without it, and turning it on by default
      // would move all of them silently.
      roomSpill: null,
    },
    pattern: { ...DEFAULT_PATTERN_PLAN },
    floorReferenceCount: 4,
    floorSigmaM: 0.003,
    freeFov: true,
  };

  archetype.apply(scenario, rng);
  scenario.floorReferenceCount = Math.min(scenario.floorReferenceCount, scenario.projectorCount);
  return scenario;
}

export function generateScenarios(
  rootSeed: number,
  count: number,
  preset: BenchPreset,
): Scenario[] {
  const out: Scenario[] = [];
  for (let i = 0; i < count; i++) out.push(makeScenario(rootSeed, i, preset));
  return out;
}

/**
 * The magnitudes actually applied, after `misalignmentScale`.
 *
 * Scaling every degree of freedom by one number keeps the *shape* of the
 * perturbation fixed while its size varies, which is what makes a sweep over
 * scale interpretable. PARAMETERS.md §2 states the azimuth tolerance as a bound
 * rather than a sigma and `packages/sim` turns it into one; nothing here
 * second-guesses that choice, it only scales it.
 */
export function scaledMisalignment(s: Scenario): Required<MisalignmentMagnitudes> {
  const k = s.misalignmentScale;
  const m = s.misalignment;
  return {
    azimuthDeg: m.azimuthDeg * k,
    distanceM: m.distanceM * k,
    heightM: m.heightM * k,
    yawDeg: m.yawDeg * k,
    pitchDeg: m.pitchDeg * k,
    rollDeg: m.rollDeg * k,
    fovHDeg: m.fovHDeg * k,
    shiftH: m.shiftH * k,
    shiftV: m.shiftV * k,
    k1: m.k1 * k,
    k2: m.k2 * k,
    centerHeightM: m.centerHeightM * k,
  };
}
