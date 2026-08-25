/**
 * The two implementations must not drift.
 *
 * `packages/usage` is wired to this repository; `skills/usage-report` is the
 * portable port of it. They deliberately differ in reach — the skill carries
 * cooling regimes, published regions and geography families that this package
 * has no flags for — but where they model the same quantity they must agree, or
 * the repository ships two different answers for the same project.
 *
 * This test exists because that already happened. A change widening
 * `gridCarbonLocation` from 200-550 to 80-600 was written as a string
 * replacement against text that did not match, in both files, and silently did
 * nothing — while the commit message, the reference doc and a reply to the user
 * all said it had been applied. Nothing failed, because nothing checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONSTANTS as TS_CONSTANTS } from '../src/impact.ts';

const SKILL = path.resolve(
  import.meta.dirname,
  '../../../skills/usage-report/scripts/impact.mjs',
);

interface Uncertain {
  low: number;
  high: number;
  unit: string;
  provenance: string;
}

const skill = (await import(pathToFileURL(SKILL).href)) as {
  CONSTANTS: Record<string, Uncertain>;
};

test('every constant the two share agrees on its bounds', () => {
  const ours = TS_CONSTANTS as unknown as Record<string, Uncertain>;
  const shared = Object.keys(ours).filter((k) => k in skill.CONSTANTS);
  assert.ok(shared.length >= 15, `expected the models to overlap heavily, got ${shared.length}`);

  const drift: string[] = [];
  for (const key of shared) {
    const a = ours[key];
    const b = skill.CONSTANTS[key];
    if (a.low !== b.low || a.high !== b.high) {
      drift.push(`${key}: package ${a.low}-${a.high} vs skill ${b.low}-${b.high}`);
    }
  }
  assert.deepEqual(drift, [], 'the two impact models disagree');
});

test('shared constants agree on units and provenance class', () => {
  // A unit mismatch is the quiet one: onSiteWue moved from per-facility to per-IT
  // kWh, and the two would still have produced plausible numbers a factor of PUE
  // apart.
  const ours = TS_CONSTANTS as unknown as Record<string, Uncertain>;
  for (const key of Object.keys(ours)) {
    const b = skill.CONSTANTS[key];
    if (b === undefined) continue;
    assert.equal(ours[key].unit, b.unit, `${key} unit`);
    assert.equal(ours[key].provenance, b.provenance, `${key} provenance`);
  }
});

test('the widened grid band is actually in both, not just in the prose', () => {
  // The specific regression. 200-550 was narrower than the published span of
  // real datacentre regions (Oregon 79 to South Carolina 576), so a band
  // labelled "unknown region" was asserting the work was not in Oregon.
  for (const [name, c] of [
    ['package', (TS_CONSTANTS as unknown as Record<string, Uncertain>)['gridCarbonLocation']],
    ['skill', skill.CONSTANTS['gridCarbonLocation']],
  ] as const) {
    assert.ok(c.low <= 80, `${name} low is ${c.low}, should bracket Oregon at 79`);
    assert.ok(c.high >= 576, `${name} high is ${c.high}, should bracket South Carolina at 576`);
  }
});
