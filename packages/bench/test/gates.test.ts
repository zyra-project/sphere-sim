/**
 * The gate step: can this repository's quality bar report failure?
 *
 * Before these tests existed the answer was no. `cli.ts` printed `VERDICT: FAIL`
 * and then set `process.exitCode = 0`, unconditionally, on the next line — so a
 * build whose pose recovery missed PARAMETERS.md §7 by 253x was green and no CI
 * step could have noticed. The first test here runs the real entry point as a
 * real process and asserts the real exit code, because a unit test of an
 * internal function would have passed on the broken version too.
 *
 * The rest are about the escape hatch, which is the dangerous part. A waiver
 * that could be written for any reason and never expired would be a slower way
 * of setting `exitCode = 0`, so each test below is one of the five ways a waiver
 * must stop covering a failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { BenchResults, GateSummary, GatesBlock } from '../src/results.ts';
import { RECOVERY_GATES } from '../src/results.ts';
import type { AmendmentEntry, GateWaiver, WaiverFile } from '../src/waivers.ts';
import {
  WAIVERS_SCHEMA,
  evaluateGates,
  parseAmendments,
  readAmendments,
  readWaivers,
  resolveCitation,
  waiverAudit,
} from '../src/waivers.ts';
import { judge, parseGateArgs } from '../src/gate.ts';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const AMENDMENTS = path.join(REPO_ROOT, 'docs', 'AMENDMENTS.md');
const WAIVERS = path.join(REPO_ROOT, 'gate-waivers.json');
const NOW = new Date('2026-08-10T12:00:00Z');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function gate(overrides: Partial<GateSummary> & { id: string }): GateSummary {
  return {
    metric: 'fixture gate',
    unit: 'mm',
    max: 2,
    klass: 'DERIVED',
    phase: 'geometry',
    basis: 'fixture',
    pass: true,
    scenariosScored: 2,
    scenariosFailed: 0,
    failedScenarios: [],
    worst: { scenario: 's01-nominal', value: 1 },
    distribution: {
      count: 2,
      mean: 1,
      median: 1,
      p05: 1,
      p95: 1,
      min: 1,
      max: 1,
      stdDev: 0,
      iqr: 0,
      values: [1, 1],
    },
    scenariosNotMeasurable: [],
    dependsOnRecovery: true,
    provisional: false,
    advisory: false,
    attribution: null,
    ...overrides,
  };
}

const FAILING = gate({
  id: 'pose_position',
  pass: false,
  scenariosScored: 2,
  scenariosFailed: 2,
  failedScenarios: ['s01-nominal', 's04-handheld'],
  worst: { scenario: 's04-handheld', value: 504 },
});

function block(gates: GateSummary[]): GatesBlock {
  return { pass: gates.every((g) => g.pass), gates, unscored: [], waivers: [] };
}

function waiver(overrides: Partial<GateWaiver> = {}): GateWaiver {
  return {
    gate: 'pose_position',
    amendment: 'A-90',
    amendmentTitle: 'a fixture amendment',
    reason: 'fixture reason',
    expires: '2027-01-01',
    ceiling: 640,
    ceilingBasis: 'fixture basis',
    scenarios: null,
    openedAt: '2026-08-10',
    openedBy: 'test',
    ...overrides,
  };
}

function file(waivers: GateWaiver[]): WaiverFile {
  return { schema: WAIVERS_SCHEMA, notes: [], waivers };
}

const FIXTURE_AMENDMENTS: AmendmentEntry[] = [
  { id: 'A-90', title: 'a fixture amendment about the pose gate', status: 'OPEN', line: 1 },
  { id: 'A-91', title: 'a decided one', status: 'ACCEPTED', line: 2 },
];

const ARCHETYPES = new Map<string, string>([
  ['s01-nominal', 'nominal'],
  ['s04-handheld', 'handheld'],
]);

function evaluate(gates: GateSummary[], waivers: GateWaiver[], now = NOW) {
  return evaluateGates({
    gates: block(gates),
    archetypeById: ARCHETYPES,
    waivers: file(waivers),
    amendments: FIXTURE_AMENDMENTS,
    now,
  });
}

function statusOf(gates: GateSummary[], waivers: GateWaiver[], now = NOW): string {
  return evaluate(gates, waivers, now).outcomes[0].status;
}

// ---------------------------------------------------------------------------
// The headline: the process exit code
// ---------------------------------------------------------------------------

test('the gate step exits non-zero on an unwaived failing gate, and zero with --allow-failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-gate-'));
  const resultsFile = path.join(dir, 'results.json');
  const waiverFile = path.join(dir, 'waivers.json');
  const results = {
    gates: block([FAILING, gate({ id: 'grid_displacement' })]),
    scenarios: [
      { id: 's01-nominal', archetype: 'nominal' },
      { id: 's04-handheld', archetype: 'handheld' },
    ],
  } as unknown as BenchResults;
  fs.writeFileSync(resultsFile, JSON.stringify(results));
  fs.writeFileSync(waiverFile, JSON.stringify(file([])));

  const run = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, 'packages', 'bench', 'src', 'gate.ts'), resultsFile, ...args],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { code: err.status ?? -1, out: err.stdout ?? '' };
    }
  };

  const failed = run(['--waivers', waiverFile, '--as-of', '2026-08-10']);
  assert.equal(failed.code, 1, 'a failing gate with no waiver must fail the build');
  assert.match(failed.out, /FAIL {2,}pose_position/);
  assert.match(failed.out, /Build FAILS/);

  const allowed = run(['--waivers', waiverFile, '--as-of', '2026-08-10', '--allow-failure']);
  assert.equal(allowed.code, 0, '--allow-failure must report without failing');
  assert.match(allowed.out, /Exit code suppressed by --allow-failure/);

  // A results file that cannot be read is its own exit code: "the bar could not
  // be read" and "the bar was not met" are different sentences.
  const unreadable = run(['--waivers', path.join(dir, 'nope', 'x.json')]);
  assert.equal(unreadable.code, 1, 'a missing waiver file just means nothing is waived');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The five ways a waiver stops covering a failure
// ---------------------------------------------------------------------------

test('a waived gate reports WAIVED, never PASS, and prints its citation', () => {
  const evaluation = evaluate([FAILING], [waiver()]);
  const outcome = evaluation.outcomes[0];
  assert.equal(outcome.status, 'WAIVED');
  assert.equal(evaluation.ok, true, 'a waived gate does not fail the build');
  assert.match(outcome.why, /A-90/, 'the citation must be printed');
  assert.match(outcome.why, /504/, 'the measured number must be printed unchanged');
  assert.match(outcome.why, /expires 2027-01-01/);
  // And the raw verdict in the results file is untouched by any of this.
  assert.equal(block([FAILING]).pass, false);
});

test('a waiver stops covering when it expires', () => {
  assert.equal(statusOf([FAILING], [waiver({ expires: '2026-08-10' })]), 'WAIVED');
  const late = evaluate([FAILING], [waiver({ expires: '2026-08-09' })]);
  assert.equal(late.outcomes[0].status, 'FAIL');
  assert.match(late.outcomes[0].why, /expired on 2026-08-09/);
  assert.equal(late.ok, false);
});

test('a waiver stops covering when the amendment it cites is decided', () => {
  const decided = evaluate([FAILING], [waiver({ amendment: 'A-91', amendmentTitle: 'a decided one' })]);
  assert.equal(decided.outcomes[0].status, 'FAIL');
  assert.match(decided.outcomes[0].why, /is ACCEPTED, not OPEN/);
});

test('a citation that does not resolve to exactly one entry cites nothing', () => {
  const missing = evaluate([FAILING], [waiver({ amendment: 'A-99' })]);
  assert.equal(missing.outcomes[0].status, 'FAIL');
  assert.match(missing.outcomes[0].why, /does not exist/);

  // The duplicate-id case, which is why citations carry a title at all: A-12 and
  // A-13 each named two different entries until they were renumbered.
  const twins: AmendmentEntry[] = [
    { id: 'A-12', title: 'lens shift has no uncertainty and it decides the pose gate', status: 'OPEN', line: 1 },
    { id: 'A-12', title: 'the pose gate is a tape-measure gate', status: 'OPEN', line: 2 },
  ];
  const ambiguous = evaluateGates({
    gates: block([FAILING]),
    archetypeById: ARCHETYPES,
    waivers: file([waiver({ amendment: 'A-12', amendmentTitle: 'the pose gate' })]),
    amendments: twins,
    now: NOW,
  });
  assert.equal(ambiguous.outcomes[0].status, 'FAIL');
  assert.match(ambiguous.outcomes[0].why, /matches 2 entries/);

  // Narrowing by title resolves it.
  const narrowed = resolveCitation(
    waiver({ amendment: 'A-12', amendmentTitle: 'tape-measure' }),
    twins,
  );
  assert.equal(narrowed.entry?.line, 2);
});

test('a waiver stops covering a failure larger than the amendment accounts for', () => {
  const worse = gate({ ...FAILING, worst: { scenario: 's04-handheld', value: 6000 } });
  const over = evaluate([worse], [waiver({ ceiling: 640 })]);
  assert.equal(over.outcomes[0].status, 'FAIL');
  assert.match(over.outcomes[0].why, /above the waiver's ceiling of 640/);
  // The same failure at the size the amendment measured is covered.
  assert.equal(statusOf([FAILING], [waiver({ ceiling: 640 })]), 'WAIVED');
});

test('a waiver stops covering when a scenario it does not name starts failing', () => {
  assert.equal(
    statusOf([FAILING], [waiver({ scenarios: ['nominal', 'handheld'] })]),
    'WAIVED',
  );
  const stray = evaluate([FAILING], [waiver({ scenarios: ['handheld'] })]);
  assert.equal(stray.outcomes[0].status, 'FAIL');
  assert.match(stray.outcomes[0].why, /s01-nominal also failed/);
});

test('a waiver on a passing gate is reported as unused rather than silently kept', () => {
  const evaluation = evaluate([gate({ id: 'pose_position' })], [waiver()]);
  assert.equal(evaluation.outcomes[0].status, 'PASS');
  assert.equal(evaluation.unused.length, 1);
  assert.match(evaluation.unused[0].why, /PASSED/);
  assert.equal(evaluation.ok, true);
});

test('a provisional gate is never judged, waiver or no waiver', () => {
  // docs/ARCHITECTURE.md's phase gate: a metric resting on an unmeasured
  // constant is reported and marked, and decides nothing — not a build, not a
  // round. Failing CI on one would encode a guess as a requirement.
  const evaluation = evaluate([gate({ ...FAILING, provisional: true })], []);
  assert.equal(evaluation.outcomes[0].status, 'NOT-JUDGED');
  assert.match(evaluation.outcomes[0].why, /PROVISIONAL/);
  assert.equal(evaluation.ok, true);
});

// ---------------------------------------------------------------------------
// The parser and the shipped files
// ---------------------------------------------------------------------------

test('the amendment parser reads ids, titles and statuses, including emphasised ones', () => {
  const parsed = parseAmendments(
    [
      '## A-01 — a heading',
      '',
      '**Status:** OPEN. Some prose.',
      '',
      '## A-02 — another',
      '',
      '**Status:** **SUPERSEDED by A-03.**',
      '',
      '## A-03 — third',
      '',
      'no status line at all',
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.map((p) => [p.id, p.status]),
    [
      ['A-01', 'OPEN'],
      ['A-02', 'SUPERSEDED'],
      ['A-03', 'UNKNOWN'],
    ],
  );
  assert.equal(parsed[0].title, 'a heading');
});

test("this repository's own waivers each cite exactly one OPEN amendment", () => {
  // The live check. `gate.ts` enforces it on every CI run, but only after a
  // hundred-second bench; this catches an amendment being resolved, retitled or
  // renumbered out from under a waiver in the unit-test pass, which is where
  // somebody editing docs/AMENDMENTS.md will actually see it.
  const waivers = readWaivers(WAIVERS);
  const amendments = readAmendments(AMENDMENTS);
  assert.ok(amendments.length >= 15, `only ${amendments.length} amendments parsed`);
  for (const w of waivers.waivers) {
    const citation = resolveCitation(w, amendments);
    assert.ok(
      citation.entry !== null,
      `waiver for '${w.gate}' cites ${w.amendment} '${w.amendmentTitle}', which matches ` +
        `${citation.candidates.length} entries by id and not exactly one by title. ` +
        'Either the entry was renumbered or its heading changed; fix the citation, do not delete the check.',
    );
    assert.equal(
      citation.entry?.status,
      'OPEN',
      `waiver for '${w.gate}' cites ${w.amendment}, which is now ${citation.entry?.status}. ` +
        'The decision has been made: meet the gate, restate it in PARAMETERS.md, or remove the waiver.',
    );
    assert.ok(
      new Date(`${w.expires}T00:00:00Z`).getTime() > Date.now(),
      `waiver for '${w.gate}' expired on ${w.expires}`,
    );
  }
});

test('a malformed waiver file is an error, not an empty list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-waiver-'));
  const write = (body: unknown): string => {
    const f = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(body));
    return f;
  };
  assert.throws(() => readWaivers(write({ schema: 'wrong', waivers: [] })), /schema/);
  assert.throws(
    () => readWaivers(write(file([waiver({ expires: 'soon' })]))),
    /want YYYY-MM-DD/,
  );
  assert.throws(
    () => readWaivers(write(file([{ ...waiver(), reason: '' }]))),
    /missing a non-empty 'reason'/,
  );
  // Silently ignoring a file somebody thought was protecting them is worse than
  // not having the file. A file that is simply absent means nothing is waived.
  assert.deepEqual(readWaivers(path.join(dir, 'absent.json')).waivers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the results-file audit is clock-free, so two runs stay byte-identical', () => {
  const audit = waiverAudit(block([FAILING]), file([waiver()]), FIXTURE_AMENDMENTS);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].amendmentStatus, 'OPEN');
  assert.equal(audit[0].gateFailed, true);
  // No field derived from `now`: the expiry DATE is recorded, the expiry
  // JUDGEMENT is not. `tools/assert-deterministic.ts` compares this file between
  // two runs and a wall-clock-derived boolean would flip at midnight.
  assert.equal(JSON.stringify(audit).includes('expired'), false);
  assert.equal(audit[0].expires, '2027-01-01');
});

test('judge() reads the real repository files and agrees with the CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-judge-'));
  const resultsFile = path.join(dir, 'results.json');
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      gates: block([gate({ id: 'grid_displacement' })]),
      scenarios: [{ id: 's01-nominal', archetype: 'nominal' }],
    }),
  );
  const options = { ...parseGateArgs([resultsFile], REPO_ROOT), now: NOW };
  const { evaluation } = judge(options);
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.outcomes[0].status, 'PASS');
  // Every shipped waiver is unused against this one passing gate, and unused is
  // reported rather than hidden.
  assert.equal(evaluation.unused.length, readWaivers(WAIVERS).waivers.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('h_center_recovery does not score a scenario where h_center was never estimated', () => {
  // The bug this pins: h_center is observable through a floor reference and
  // nothing else, so with none supplied the solver holds it at the documented
  // nominal and never estimates it. Scoring that scenario measured the
  // SIMULATOR's own perturbation draw — whose sigma is 25.4 mm precisely because
  // PARAMETERS.md §1 names NOAA's inch — so the gate was reading back the
  // constant it exists to test against, and calling a 53 mm draw a failure.
  const spec = RECOVERY_GATES.find((g) => g.id === 'h_center_recovery');
  assert.ok(spec !== undefined, 'the gate is gone');
  assert.ok(spec.measurable !== undefined, 'the gate must declare when it can be scored');

  const withReference = {
    recovery: { centerHeight: { errorMm: 4, observed: true } },
  } as unknown as Parameters<NonNullable<typeof spec.measurable>>[0];
  const without = {
    recovery: { centerHeight: { errorMm: 53.27, observed: false } },
  } as unknown as Parameters<NonNullable<typeof spec.measurable>>[0];

  assert.equal(spec.measurable(withReference), true, 'an estimated h_center must be scored');
  assert.equal(spec.measurable(without), false, 'an un-estimated h_center must not be scored');
});

test('the recovery gates that ARE always measurable stay that way', () => {
  // The escape hatch above must not spread. Pose recovery is a comparison
  // between two rigs the simulator built; it is always available.
  for (const id of ['pose_position', 'pose_rotation']) {
    const spec = RECOVERY_GATES.find((g) => g.id === id);
    assert.ok(spec !== undefined, `${id} is gone`);
    assert.equal(spec.measurable, undefined, `${id} must not have acquired a measurable() guard`);
  }
});
