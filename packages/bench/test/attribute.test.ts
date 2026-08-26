// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Failure attribution: does the name the bench prints mean anything?
 *
 * `docs/ARCHITECTURE.md`'s loop protocol turns one string into an assignment —
 * "the critic names the single largest contributor and that piece goes back" —
 * so a name that is an artefact of the code rather than a measurement sends a
 * builder after the wrong piece for a whole round. Both tests below are for
 * names that were exactly that.
 *
 * Neither defect was hypothetical. The shipped `bench-results.json` records
 * `grid_displacement -> contributor: "none"` and `h_center_recovery ->
 * explainedFraction: 0.5` on a split whose predicate can no longer produce that
 * number, and `docs/PHASE-1.md` had to gloss the first one in prose ("Round 3's
 * named contributor - and it is none of the above") because the machine could
 * not say it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { attributeCenterHeightFailure, largestContributor } from '../src/attribute.ts';
import type { ScenarioResult } from '../src/run.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Only the two fields `attributeCenterHeightFailure` reads. The real
 * `ScenarioResult` carries a solve, a capture, two metric sets and a rig; none
 * of it participates in an observability split, and building it would make the
 * test about the solver instead of about the attribution.
 */
function scenario(id: string, observed: boolean | null, errorMm: number): ScenarioResult {
  return {
    scenario: { id },
    recovery: observed === null ? null : { centerHeight: { observed, errorMm } },
  } as unknown as ScenarioResult;
}

/**
 * The measured substitution table for `s09-long-throw` as recorded in the
 * shipped `bench-results.json` - the exact numbers that made the bench print
 * `contributor: "none"`. Every single-group substitution raises the metric
 * above the 12.651 mm it reports as recovered; `centerHeight` reproduces it to
 * the last digit because a long-throw solve with no floor reference never moved
 * that parameter; and only the `all` bookend fixes it, at 0.060 mm.
 */
const S09_MEASURED: readonly { group: string; value: number }[] = [
  { group: 'none', value: 12.65066097516779 },
  { group: 'position', value: 111.46133171124048 },
  { group: 'rotation', value: 47.13973817731265 },
  { group: 'fov', value: 153.91554914632025 },
  { group: 'shift', value: 117.06578854044537 },
  { group: 'radial', value: 50.867395597655026 },
  { group: 'centerHeight', value: 12.65066097516779 },
  { group: 'all', value: 0.059885479652264095 },
];

// ---------------------------------------------------------------------------
// largestContributor
// ---------------------------------------------------------------------------

test('a compensating deformation is reported as no group, not as a group called "none"', () => {
  const { group, drop } = largestContributor(S09_MEASURED, 12.65066097516779);

  // The old loop seeded `best` with the string 'none' - the name of the
  // no-substitution bookend - and only reassigned on a positive drop. On this
  // table there is no positive drop, so the results file named a parameter
  // group that does not exist and cannot be sent back to anyone.
  assert.equal(group, null, 'no single group reduces the metric, so no group is named');
  assert.equal(drop, 0, 'and nothing is claimed to have been removed');
});

test('the bookends are never candidates, even when `all` has the largest drop', () => {
  // `all` drops the metric by 12.59 mm here, far more than any real group could,
  // because it replaces the entire calibration. Naming it would tell a builder
  // to go and fix everything.
  const { group } = largestContributor(S09_MEASURED, 12.65066097516779);
  assert.equal(group, null);

  // Same table, but with one group made genuinely helpful. `all` is still the
  // biggest drop by a wide margin and must still lose.
  const withAWinner = S09_MEASURED.map((g) =>
    g.group === 'rotation' ? { group: 'rotation', value: 4 } : g,
  );
  const best = largestContributor(withAWinner, 12.65066097516779);
  assert.equal(best.group, 'rotation');
  assert.ok(
    Math.abs(best.drop - 8.65066097516779) < 1e-12,
    'the drop is measured against the reported value, not against `all`',
  );
});

test('a substitution that changes nothing is not a contributor', () => {
  // `centerHeight` reproduces the recovered value exactly in the measured table
  // above. A drop of exactly zero is not evidence that a group carries the
  // failure, so the strict comparison is the right one.
  const { group } = largestContributor(
    [
      { group: 'none', value: 10 },
      { group: 'centerHeight', value: 10 },
    ],
    10,
  );
  assert.equal(group, null);
});

// ---------------------------------------------------------------------------
// attributeCenterHeightFailure
// ---------------------------------------------------------------------------

test('the observability split counts the scenarios the gate excludes, not an empty half', () => {
  // The corpus the gate actually sees: two scenarios fail with a floor
  // reference, two more have none at all. `RECOVERY_GATES`' h_center spec
  // carries `measurable: (r) => observed === true`, so those two are routed
  // into `scenariosNotMeasurable` and are NOT in `failedScenarioIds` - which is
  // the whole point, and is what the old split could not see.
  const results = [
    scenario('s01-nominal', true, 1),
    scenario('s02-drifted', true, 44),
    scenario('s03-tripod', true, 12),
    scenario('s10-no-floor-reference', false, 300),
    scenario('s11-no-floor-reference-b', false, 280),
  ];
  const att = attributeCenterHeightFailure(results, ['s02-drifted', 's03-tripod'], 10);
  assert.ok(att !== null);

  // The old code partitioned the FAILING set by observability, found nothing on
  // the unobserved side because the gate had already removed it, and divided by
  // the total: `explainedFraction: 0`. A contributor that explains 0% of the
  // failures it is named for is not a finding.
  assert.equal(att.explainedFraction, 1, 'every failure is in the named bucket');
  assert.equal(att.contributor, 'floor-reference noise and network geometry');

  const byGroup = new Map(att.byGroup.map((g) => [g.group, g.value]));
  assert.equal(byGroup.get('failing, floor reference supplied'), 2);
  assert.equal(byGroup.get('failing, no floor reference'), 0);
  assert.equal(
    byGroup.get('excluded from the gate, no floor reference'),
    2,
    'the unobserved scenarios are counted where they actually are - outside the gate',
  );

  // And they are visible in the prose, not just in the numbers.
  assert.match(att.explains, /2 more had none/);
  assert.match(att.note, /does not score them and they cannot fail it/);

  // The worst failing scenario is still the one reported.
  assert.equal(att.scenario, 's02-drifted');
});

test('an unobserved scenario that DOES reach the gate still names the missing floor reference', () => {
  // Results predating the `measurable` predicate - and any future run where an
  // unobserved scenario reaches the gate - must keep the old answer. The fix
  // moves where the unobserved scenarios are counted; it does not change what
  // they mean when they genuinely fail.
  const results = [
    scenario('s02-drifted', true, 44),
    scenario('s10-no-floor-reference', false, 300),
  ];
  const att = attributeCenterHeightFailure(results, ['s02-drifted', 's10-no-floor-reference'], 10);
  assert.ok(att !== null);
  assert.equal(att.contributor, 'no floor reference (h_center held, not solved)');
  assert.equal(att.explainedFraction, 0.5);
  assert.equal(att.scenario, 's10-no-floor-reference', 'the worst error is the unobserved one');
});

test('with nothing unobserved anywhere in the corpus, the split says so and stays quiet', () => {
  const results = [scenario('s01-nominal', true, 1), scenario('s02-drifted', true, 44)];
  const att = attributeCenterHeightFailure(results, ['s02-drifted'], 10);
  assert.ok(att !== null);
  assert.equal(att.explainedFraction, 1);
  assert.equal(att.byGroup.find((g) => g.group.startsWith('excluded'))?.value, 0);
  assert.doesNotMatch(att.explains, /more had none/);
  assert.doesNotMatch(att.note, /A further/);
});

test('no failing scenarios is not an attribution', () => {
  assert.equal(attributeCenterHeightFailure([scenario('s01-nominal', true, 1)], [], 10), null);
});
