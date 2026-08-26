// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Unlit fraction WITHIN the mask boundary — PARAMETERS.md §7's only gate with no
 * tolerance.
 *
 * ## The domain is the whole metric
 *
 * §7 is explicit that this is "computed inside `mask_lo`, not over the full
 * sphere", and that distinction is not a detail. Over the full sphere the answer
 * is never zero: §4.3 puts a permanently unlit, four-lobed, scalloped region at
 * each pole — about 0.89% of the sphere per pole at `d_proj` = 5.18 m (see
 * docs/AMENDMENTS.md A-05) — and no alignment can remove it, because the poles
 * sit exactly 90 degrees from every lens and the limb is at 80.4. A 0%
 * requirement over the full sphere would be unsatisfiable by construction.
 * Inside the mask boundary it is a real and achievable requirement.
 *
 * ## Why both readings of `bottommask` are reported
 *
 * docs/AMENDMENTS.md A-02: §4.4 reads `set bottommask 60,70` as onset and
 * full-mask LATITUDE and marks the reading `ASSUME — verify`. So an inferred
 * unit governs the domain of the only gate with no tolerance. If the values are
 * colatitude instead, the protected boundary moves from |lat| 60 to |lat| 20 and
 * the gate silently tests a different region. The latitude reading is well
 * supported — §4.4's observation that 60 matches the computed seam-direction
 * usable limit of ~59 is a strong coincidence — but "well supported" is not
 * "measured", so both are computed and both appear in the report. The
 * configured reading is the one scored.
 *
 * ## The domain is symmetric even though the mask is not
 *
 * `bottomOnly` is true because the sphere hangs from a ceiling mount that
 * physically occludes the north polar cap (§1, §4.4) — the north needs no
 * software mask because hardware already covers it. But the north cap is still
 * geometrically unlit down to latitude 76.3, and if the gate's domain followed
 * `bottomOnly` it would take in that whole permanently-dark region and report a
 * catastrophic failure for a rig that is behaving exactly as §4.3 says it must.
 * So the domain is `|lat| <= onset` on ABSOLUTE latitude, applied at both poles,
 * which is the natural reading of "inside `mask_lo`" and the only one under
 * which the gate means anything.
 *
 * ## Two independent checks, because sampling can miss a hole
 *
 * Point sampling can only find a gap bigger than its own spacing. So alongside
 * the sampled fraction this reports the BOUNDARY MARGIN: the minimum over
 * longitude of the coverage boundary latitude, minus the domain edge. That is
 * found by bisection on the coverage test itself and is not a sampling estimate
 * at all — it says how many degrees of latitude of headroom the rig has before
 * the unlit region reaches the protected zone. A positive margin with a zero
 * sampled fraction is two independent ways of saying the same thing.
 */

import type { BlendCalibration, RigCalibration } from '../../../calibration/src/index.ts';
import { latLonToWorld } from '../geometry.ts';
import type { PreparedRig } from '../optics.ts';
import { prepareRig } from '../optics.ts';
import type { MaskInterpretation } from '../coverage.ts';
import { coverageBoundaryLatitude, isIlluminatedAt, polarMask } from '../coverage.ts';
import { DEG2RAD } from '../vec.ts';
import type { ConvergenceReport, MetricGate, MetricResult, SamplingReport } from './types.ts';
import { convergenceOf, makeMetric } from './types.ts';
import { densityPair, equalAreaLattice } from './sampling.ts';

export interface UnlitOptions {
  /** Equal-area lattice size over the whole sphere, before restriction. */
  sampleCount?: number;
  /** Longitudes at which the coverage boundary is bisected, per pole. */
  boundarySamples?: number;
  convergence?: boolean;
}

/** The gate's answer under one reading of `bottommask`. */
export interface UnlitReading {
  interpretation: MaskInterpretation;
  /** Absolute latitude at which the mask begins to attenuate, degrees. */
  onsetLatDeg: number;
  /** `sin(onset)` — the domain's area as a fraction of the sphere. */
  domainAreaFraction: number;
  samplesInDomain: number;
  unlitSamples: number;
  /** Unlit samples over samples in the domain. THE gated quantity. */
  unlitFractionOfDomain: number;
  /** The same as a fraction of the whole sphere, for cross-referencing §4.3. */
  unlitFractionOfSphere: number;
  /** Degrees of latitude between the domain edge and the unlit region, per pole. */
  boundaryMarginNorthDeg: number;
  boundaryMarginSouthDeg: number;
  /** Up to 32 unlit locations, for the report to point at something. */
  examples: { latDeg: number; lonDeg: number }[];
}

export interface UnlitReport {
  /** The reading the scene configures, and the one the metric scores. */
  primary: UnlitReading;
  /** The other reading of `bottommask`, per A-02. Reported, not scored. */
  secondary: UnlitReading;
  metric: MetricResult;
  secondaryMetric: MetricResult;
  sampling: SamplingReport;
}

/**
 * Absolute latitude at which the polar mask starts to attenuate.
 *
 * Found by bisecting `polarMask` itself with `bottomOnly` forced off, rather
 * than by restating `maskLoDeg` / `90 - maskHiDeg` here. Restating it would make
 * this module and `coverage.ts` two places that have to agree about what the
 * colatitude reading means; bisecting means there is only one definition and
 * this module reads it.
 *
 * The predicate is `mask >= 1`, not `mask > 1 - epsilon`. conventions.ts §M's
 * feather is a cosine, whose derivative is zero at both ends, so an epsilon-level
 * test resolves the onset only to `sqrt(epsilon)`.
 */
export function maskOnsetLatitude(blend: BlendCalibration, interp: MaskInterpretation): number {
  const symmetric: BlendCalibration = { ...blend, bottomOnly: false };
  if (polarMask(0, symmetric, interp) < 1) return 0;
  let lo = 0;
  let hi = 90;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (polarMask(mid, symmetric, interp) >= 1) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Minimum coverage boundary latitude over longitude, for one pole. */
function minimumBoundaryLatitude(rig: PreparedRig, sign: 1 | -1, samples: number): number {
  let worst = 90;
  for (let i = 0; i < samples; i++) {
    const lon = -180 + (360 * i) / samples;
    worst = Math.min(worst, coverageBoundaryLatitude(lon, rig, sign));
  }
  return worst;
}

function readingFor(
  rig: PreparedRig,
  interpretation: MaskInterpretation,
  count: number,
  boundarySamples: number,
  keepExamples: boolean,
): UnlitReading {
  const onsetLatDeg = maskOnsetLatitude(rig.blend, interpretation);
  const lattice = equalAreaLattice(count);

  let samplesInDomain = 0;
  let unlitSamples = 0;
  const examples: { latDeg: number; lonDeg: number }[] = [];
  for (const s of lattice) {
    if (Math.abs(s.latDeg) > onsetLatDeg) continue;
    samplesInDomain++;
    const point = latLonToWorld(s.latDeg, s.lonDeg, rig.radiusM);
    let lit = false;
    for (const p of rig.projectors) {
      if (isIlluminatedAt(point, p)) {
        lit = true;
        break;
      }
    }
    if (!lit) {
      unlitSamples++;
      if (keepExamples && examples.length < 32) {
        examples.push({ latDeg: s.latDeg, lonDeg: s.lonDeg });
      }
    }
  }

  return {
    interpretation,
    onsetLatDeg,
    // The band |lat| <= L has area 4*pi*R^2*sin(L), so its fraction is sin(L).
    domainAreaFraction: Math.sin(onsetLatDeg * DEG2RAD),
    samplesInDomain,
    unlitSamples,
    unlitFractionOfDomain: samplesInDomain > 0 ? unlitSamples / samplesInDomain : NaN,
    unlitFractionOfSphere: count > 0 ? unlitSamples / count : NaN,
    boundaryMarginNorthDeg: minimumBoundaryLatitude(rig, 1, boundarySamples) - onsetLatDeg,
    boundaryMarginSouthDeg: minimumBoundaryLatitude(rig, -1, boundarySamples) - onsetLatDeg,
    examples,
  };
}

function otherInterpretation(interp: MaskInterpretation): MaskInterpretation {
  return interp === 'latitude' ? 'colatitude' : 'latitude';
}

export function computeUnlitInMask(
  physicalRig: RigCalibration,
  maskInterpretation: MaskInterpretation,
  gate: MetricGate,
  options: UnlitOptions = {},
  densityScale = 1,
): UnlitReport {
  const rig = prepareRig(physicalRig);
  const { fine, coarse } = densityPair(options.sampleCount ?? 20000, densityScale);
  const boundarySamples = Math.max(36, Math.round((options.boundarySamples ?? 360) * densityScale));
  const wantConvergence = options.convergence ?? true;

  const primary = readingFor(rig, maskInterpretation, fine, boundarySamples, true);
  const secondary = readingFor(
    rig,
    otherInterpretation(maskInterpretation),
    fine,
    boundarySamples,
    true,
  );

  let convergence: ConvergenceReport | null = null;
  if (wantConvergence) {
    const coarseReading = readingFor(rig, maskInterpretation, coarse, boundarySamples, false);
    convergence = convergenceOf(
      primary.unlitFractionOfDomain,
      coarseReading.unlitFractionOfDomain,
      coarseReading.samplesInDomain,
      // The gate is exactly zero, so any nonzero disagreement between densities
      // matters. One sample's worth at the coarse density is the tolerance.
      coarseReading.samplesInDomain > 0 ? 1 / coarseReading.samplesInDomain : 1,
    );
  }

  const marginNote =
    `Boundary margin: the unlit region stops ` +
    `${primary.boundaryMarginNorthDeg.toFixed(2)} deg of latitude north and ` +
    `${primary.boundaryMarginSouthDeg.toFixed(2)} deg south of the domain edge at ` +
    `|lat| = ${primary.onsetLatDeg.toFixed(1)}.`;

  const sampling: SamplingReport = {
    scheme: 'fibonacci-equal-area+boundary-bisection',
    description:
      `${fine}-point equal-area lattice over the sphere, of which ${primary.samplesInDomain} fall ` +
      `inside |lat| <= ${primary.onsetLatDeg.toFixed(1)} deg. Backed by an independent bisection of ` +
      `the coverage boundary at ${boundarySamples} longitudes per pole, which does not depend on ` +
      `sample spacing and would catch a gap smaller than the lattice can resolve.`,
    count: primary.samplesInDomain,
    densityPerSr: fine / (4 * Math.PI),
    convergence,
  };

  const metric = makeMetric({
    id: 'unlit_in_mask',
    label: `Unlit fraction within the mask boundary (${maskInterpretation} reading)`,
    value: primary.unlitFractionOfDomain,
    unit: 'fraction of the protected region',
    gate,
    scored: true,
    note:
      `Computed inside |lat| <= ${primary.onsetLatDeg.toFixed(1)} deg, the latitude at which ` +
      `\`set bottommask\` begins to attenuate under the ${maskInterpretation} reading — NOT over ` +
      'the full sphere, where §4.3\'s permanently unlit polar lobes make 0% unreachable by ' +
      'construction. The domain is symmetric in absolute latitude even though the mask is ' +
      'bottom-only: the north cap is occluded by the ceiling mount rather than masked in software, ' +
      'and folding its permanent darkness into this gate would fail every correctly-built rig. ' +
      marginNote +
      ' docs/AMENDMENTS.md A-02: the unit of `bottommask` is inferred, not published, and it ' +
      'defines this gate\'s domain — see the secondary reading.',
    sampling,
    detail: {
      onsetLatDeg: primary.onsetLatDeg,
      domainAreaFraction: primary.domainAreaFraction,
      samplesInDomain: primary.samplesInDomain,
      unlitSamples: primary.unlitSamples,
      unlitFractionOfSphere: primary.unlitFractionOfSphere,
      boundaryMarginNorthDeg: primary.boundaryMarginNorthDeg,
      boundaryMarginSouthDeg: primary.boundaryMarginSouthDeg,
    },
  });

  const secondaryMetric = makeMetric({
    id: 'unlit_in_mask_alt_units',
    label: `Unlit fraction within the mask boundary (${secondary.interpretation} reading)`,
    value: secondary.unlitFractionOfDomain,
    unit: 'fraction of the protected region',
    gate,
    scored: false,
    note:
      'REFERENCE ONLY, NOT SCORED. docs/AMENDMENTS.md A-02: `set bottommask 60,70` is read as ' +
      'latitude, but that reading is inferred and it governs the domain of the only gate with no ' +
      `tolerance. Under the ${secondary.interpretation} reading the domain edge moves from ` +
      `|lat| ${primary.onsetLatDeg.toFixed(1)} to |lat| ${secondary.onsetLatDeg.toFixed(1)}. ` +
      'Reported so the inferred-units risk is visible in the output rather than buried in a ' +
      'comment; §8 item 15 is the measurement that would settle it.',
    sampling,
    detail: {
      onsetLatDeg: secondary.onsetLatDeg,
      domainAreaFraction: secondary.domainAreaFraction,
      samplesInDomain: secondary.samplesInDomain,
      unlitSamples: secondary.unlitSamples,
      unlitFractionOfSphere: secondary.unlitFractionOfSphere,
      boundaryMarginNorthDeg: secondary.boundaryMarginNorthDeg,
      boundaryMarginSouthDeg: secondary.boundaryMarginSouthDeg,
    },
  });

  return { primary, secondary, metric, secondaryMetric, sampling };
}
