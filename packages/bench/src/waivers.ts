/**
 * Gate waivers — how a gate is allowed to fail without making CI meaningless,
 * and how it is not.
 *
 * ## The problem this solves, stated honestly
 *
 * Two facts are both true and they pull in opposite directions.
 *
 * 1. `packages/bench/src/cli.ts` used to set `process.exitCode = 0`
 *    unconditionally, one line after printing `VERDICT: FAIL`. A build whose
 *    pose recovery missed §7's gate by 253x was green. A quality bar that cannot
 *    report failure is not a quality bar.
 * 2. Some of §7's gates cannot be met, for reasons that are nothing to do with
 *    the code and are already measured and written down. docs/AMENDMENTS.md
 *    A-12 ("the pose gate is a tape-measure gate") shows the solver recovers
 *    pose to 0.073 mm with the sensor and reference noise removed, and that the
 *    3 mm tape measure PARAMETERS.md §8 prescribes puts a ~4.4 mm floor under a
 *    2 mm gate. No camera and no solver reaches it. A CI that is red forever
 *    teaches everyone to ignore CI, and then fact 1 is back.
 *
 * A waiver is the join between them: a gate may fail WITHOUT failing the build
 * only where the project has already written down why, in `docs/AMENDMENTS.md`,
 * and only until a stated date. It is not a tuning knob. The measured number is
 * reported unchanged, the gate is reported as WAIVED rather than PASS, and the
 * citation is printed every time.
 *
 * ## The five ways a waiver stops covering a failure
 *
 * Each is a build failure, because each means the waiver has stopped being an
 * accurate statement about the project:
 *
 *   - **expired** — the date passed. A waiver with no expiry is a permanent
 *     exemption, which is the thing this file exists to prevent.
 *   - **amendment resolved** — the entry it cites is no longer `OPEN`. Somebody
 *     decided; the gate must now be restated or met, and the waiver removed.
 *   - **amendment missing or ambiguous** — the citation does not resolve to
 *     exactly one entry. (A-12 and A-13 are each used twice in AMENDMENTS.md, so
 *     a citation carries a title fragment as well as an id.)
 *   - **ceiling exceeded** — the amendment accounts for a failure of a stated
 *     size, and the measurement is bigger than that. This is what keeps the
 *     alarm live: a waiver for the ~640 mm the fov/distance valley is known to
 *     cost does not cover 6 metres.
 *   - **scenario not covered** — the waiver names the archetypes the amendment
 *     explains, and some other scenario started failing.
 *
 * ## What a waiver deliberately does NOT do
 *
 * It does not change a metric, a gate limit, or a scenario. It does not make the
 * verdict in `bench-results.json` say PASS: `gates.pass` there stays the raw
 * measurement. It records that the project knows why a number is what it is, and
 * where the decision is pending.
 */

import * as fs from 'node:fs';
import type { GateSummary, GatesBlock } from './results.ts';

export const WAIVERS_SCHEMA = 'sphere-sim/gate-waivers@1';

/** One waiver, as it appears in `gate-waivers.json`. */
export interface GateWaiver {
  /** Gate id, matching `gates[].id` in bench-results.json. */
  gate: string;
  /** Amendment id, e.g. `A-12`. */
  amendment: string;
  /**
   * A fragment of the amendment's heading, matched case-insensitively. Required
   * because AMENDMENTS.md reuses A-12 and A-13 for two entries each, and a
   * citation that resolves to two different arguments cites neither.
   */
  amendmentTitle: string;
  /** Why this failure is the amendment's and not a defect. Printed verbatim. */
  reason: string;
  /** `YYYY-MM-DD`, inclusive. After this date the waiver fails the build. */
  expires: string;
  /**
   * Largest value, IN THE GATE'S OWN UNIT, that the cited amendment accounts
   * for. A measurement above it is not covered. `null` waives the gate at any
   * value and must be argued for in `ceilingBasis`.
   */
  ceiling: number | null;
  /** Where the ceiling comes from. A ceiling with no provenance is a fudge. */
  ceilingBasis: string;
  /**
   * Scenario ARCHETYPES this covers (`nominal`, `handheld`, ...), or `null` for
   * every scenario. A narrower scope is a louder alarm.
   */
  scenarios: string[] | null;
  openedAt: string;
  openedBy: string;
}

export interface WaiverFile {
  schema: string;
  notes: string[];
  waivers: GateWaiver[];
}

/** One `## A-NN — title` entry of docs/AMENDMENTS.md, with its status. */
export interface AmendmentEntry {
  id: string;
  title: string;
  /** `OPEN`, `ACCEPTED`, `REJECTED`, `APPLIED`, or `UNKNOWN`. */
  status: string;
  line: number;
}

/**
 * Read the amendment index out of the markdown.
 *
 * Deliberately a parse of the document itself rather than a second copy of the
 * statuses in JSON. A copy would drift, and the drift would always be in the
 * direction of the waiver outliving the decision.
 *
 * The first `**Status:**` line after a heading wins: A-08 carries two, the
 * second being the history of the entry before it was applied.
 */
export function parseAmendments(markdown: string): AmendmentEntry[] {
  const lines = markdown.split('\n');
  const out: AmendmentEntry[] = [];
  let current: AmendmentEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+(A-\d+)\s*[—–-]\s*(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      current = { id: heading[1], title: heading[2], status: 'UNKNOWN', line: i + 1 };
      out.push(current);
      continue;
    }
    if (current !== null && current.status === 'UNKNOWN') {
      const status = /^\*\*Status:\*\*\s*([A-Za-z]+)/.exec(lines[i]);
      if (status) current.status = status[1].toUpperCase();
    }
  }
  return out;
}

export function readAmendments(file: string): AmendmentEntry[] {
  return parseAmendments(fs.readFileSync(file, 'utf8'));
}

/**
 * Read `gate-waivers.json`.
 *
 * A missing file is not an error — it means no gate is waived, which is the
 * state the project should be trying to reach. A malformed one IS an error: the
 * failure mode of silently ignoring a file somebody thought was protecting them
 * is worse than not having it.
 */
export function readWaivers(file: string): WaiverFile {
  if (!fs.existsSync(file)) return { schema: WAIVERS_SCHEMA, notes: [], waivers: [] };
  const raw = fs.readFileSync(file, 'utf8');
  let parsed: WaiverFile;
  try {
    parsed = JSON.parse(raw) as WaiverFile;
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (parsed.schema !== WAIVERS_SCHEMA) {
    throw new Error(`${file}: schema is '${parsed.schema}', expected '${WAIVERS_SCHEMA}'`);
  }
  if (!Array.isArray(parsed.waivers)) throw new Error(`${file}: 'waivers' must be an array`);
  for (const w of parsed.waivers) {
    for (const key of ['gate', 'amendment', 'amendmentTitle', 'reason', 'expires', 'ceilingBasis'] as const) {
      if (typeof w[key] !== 'string' || w[key].length === 0) {
        throw new Error(`${file}: waiver for '${w.gate}' is missing a non-empty '${key}'`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.expires)) {
      throw new Error(`${file}: waiver for '${w.gate}' has expires='${w.expires}', want YYYY-MM-DD`);
    }
    if (w.ceiling !== null && !(typeof w.ceiling === 'number' && Number.isFinite(w.ceiling))) {
      throw new Error(`${file}: waiver for '${w.gate}' has a non-numeric ceiling`);
    }
    if (w.scenarios !== null && !Array.isArray(w.scenarios)) {
      throw new Error(`${file}: waiver for '${w.gate}' has a non-array, non-null 'scenarios'`);
    }
  }
  return parsed;
}

/** What a citation resolved to. */
export interface Citation {
  waiver: GateWaiver;
  entry: AmendmentEntry | null;
  /** Every entry the id matched, before the title narrowed it. Diagnostics. */
  candidates: AmendmentEntry[];
}

export function resolveCitation(waiver: GateWaiver, amendments: readonly AmendmentEntry[]): Citation {
  const candidates = amendments.filter((a) => a.id === waiver.amendment);
  const needle = waiver.amendmentTitle.toLowerCase();
  const matched = candidates.filter((a) => a.title.toLowerCase().includes(needle));
  return { waiver, entry: matched.length === 1 ? matched[0] : null, candidates };
}

export type GateStatus = 'PASS' | 'WAIVED' | 'FAIL' | 'NOT-JUDGED';

export interface GateOutcome {
  id: string;
  status: GateStatus;
  /** One line, printed under the gate. Always says why, never just what. */
  why: string;
  waiver: GateWaiver | null;
  citation: Citation | null;
}

export interface EvaluationInput {
  gates: GatesBlock;
  /** Scenario id -> archetype, for scoping a waiver to the cases it explains. */
  archetypeById: ReadonlyMap<string, string>;
  waivers: WaiverFile;
  amendments: readonly AmendmentEntry[];
  /** Injected rather than read from the clock, so a test can pin it. */
  now: Date;
}

export interface Evaluation {
  outcomes: GateOutcome[];
  /** Waivers that matched no failing gate. Reported, not fatal. */
  unused: { waiver: GateWaiver; why: string }[];
  /** True when nothing failed without cover. The build's verdict. */
  ok: boolean;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Judge every gate.
 *
 * Only SCORED, NON-PROVISIONAL gates can fail the build. A provisional metric is
 * a statement about a constant nobody has measured (docs/ARCHITECTURE.md's phase
 * gate); failing a build on one would encode a guess as a requirement.
 */
export function evaluateGates(input: EvaluationInput): Evaluation {
  const outcomes: GateOutcome[] = [];
  const used = new Set<GateWaiver>();

  for (const gate of input.gates.gates) {
    const waiver = input.waivers.waivers.find((w) => w.gate === gate.id) ?? null;
    if (gate.provisional) {
      outcomes.push({
        id: gate.id,
        status: 'NOT-JUDGED',
        why: 'PROVISIONAL — depends on a constant nobody has measured (docs/ARCHITECTURE.md phase gate). Reported, never scored.',
        waiver,
        citation: null,
      });
      continue;
    }
    if (gate.pass) {
      outcomes.push({ id: gate.id, status: 'PASS', why: '', waiver, citation: null });
      continue;
    }
    if (waiver === null) {
      outcomes.push({
        id: gate.id,
        status: 'FAIL',
        why:
          `no waiver in gate-waivers.json. ${gate.scenariosFailed}/${gate.scenariosScored} scenarios failed` +
          `${gate.worst === null ? '' : `, worst ${gate.worst.value} ${gate.unit} on ${gate.worst.scenario}`}` +
          ` against a limit of ${gate.max}.`,
        waiver: null,
        citation: null,
      });
      continue;
    }

    used.add(waiver);
    outcomes.push(judgeWaived(gate, waiver, input));
  }

  const unused: { waiver: GateWaiver; why: string }[] = [];
  for (const w of input.waivers.waivers) {
    if (used.has(w)) continue;
    const gate = input.gates.gates.find((g) => g.id === w.gate);
    unused.push({
      waiver: w,
      why:
        gate === undefined
          ? `no gate '${w.gate}' in this run — the waiver may name a gate that no longer exists.`
          : `gate '${w.gate}' PASSED. The waiver did nothing; delete it once it stays that way.`,
    });
  }

  return { outcomes, unused, ok: outcomes.every((o) => o.status !== 'FAIL') };
}

function judgeWaived(gate: GateSummary, waiver: GateWaiver, input: EvaluationInput): GateOutcome {
  const citation = resolveCitation(waiver, input.amendments);
  const fail = (why: string): GateOutcome => ({ id: gate.id, status: 'FAIL', why, waiver, citation });

  if (citation.entry === null) {
    return fail(
      citation.candidates.length === 0
        ? `waiver cites ${waiver.amendment}, which does not exist in docs/AMENDMENTS.md.`
        : `waiver cites ${waiver.amendment} '${waiver.amendmentTitle}', which matches ` +
          `${citation.candidates.length === 1 ? 'no' : `${citation.candidates.length}`} entries ` +
          `(${citation.candidates.map((c) => `line ${c.line}: ${c.title}`).join(' | ')}). ` +
          'A citation that does not resolve to exactly one entry cites nothing.',
    );
  }
  if (citation.entry.status !== 'OPEN') {
    return fail(
      `${waiver.amendment} is ${citation.entry.status}, not OPEN — the decision has been made ` +
        `(docs/AMENDMENTS.md line ${citation.entry.line}). Meet the gate, restate it in PARAMETERS.md, ` +
        'or the waiver is now hiding a live failure.',
    );
  }
  const today = isoDay(input.now);
  if (today > waiver.expires) {
    return fail(
      `waiver expired on ${waiver.expires} (today is ${today}). Renew it with a fresh argument or remove it.`,
    );
  }
  if (waiver.ceiling !== null && gate.worst !== null && gate.worst.value > waiver.ceiling) {
    return fail(
      `measured ${gate.worst.value} ${gate.unit} on ${gate.worst.scenario}, above the waiver's ceiling of ` +
        `${waiver.ceiling} ${gate.unit}. ${waiver.ceilingBasis} A failure larger than the one the amendment ` +
        'accounts for is a new failure.',
    );
  }
  if (waiver.scenarios !== null) {
    const covered = new Set(waiver.scenarios);
    const stray = gate.failedScenarios.filter((id) => !covered.has(input.archetypeById.get(id) ?? id));
    if (stray.length > 0) {
      return fail(
        `waiver covers archetypes [${waiver.scenarios.join(', ')}], but ${stray.join(', ')} also failed. ` +
          'A scenario the amendment does not discuss is not waived by it.',
      );
    }
  }

  return {
    id: gate.id,
    status: 'WAIVED',
    why:
      `${waiver.amendment} (${citation.entry.title}), OPEN, expires ${waiver.expires}. ${waiver.reason} ` +
      `Reported unchanged: ${gate.worst === null ? 'n/a' : `${gate.worst.value} ${gate.unit} worst`} ` +
      `against a limit of ${gate.max}` +
      `${waiver.ceiling === null ? '' : `, waived up to ${waiver.ceiling}`}.`,
    waiver,
    citation,
  };
}

/**
 * The audit rows that go into `bench-results.json`.
 *
 * Everything here is a pure function of two files on disk, so the results file
 * stays byte-identical between two runs with the same seed. The one thing that
 * needs a clock — whether the waiver has expired — is deliberately NOT here: it
 * is decided at print time, by `evaluateGates`, and shows up in the exit code
 * and on stdout. A results file whose content depended on the wall clock would
 * break the determinism check for a reason that has nothing to do with
 * determinism, which is the same trap `env.argv` fell into.
 */
export interface WaiverAudit {
  gate: string;
  amendment: string;
  amendmentTitle: string;
  /** Status parsed out of docs/AMENDMENTS.md at the time of the run. */
  amendmentStatus: string;
  amendmentResolvesUniquely: boolean;
  expires: string;
  ceiling: number | null;
  ceilingBasis: string;
  scenarios: string[] | null;
  reason: string;
  /** True when the gate this waiver names actually failed in this run. */
  gateFailed: boolean;
}

export function waiverAudit(
  gates: GatesBlock,
  waivers: WaiverFile,
  amendments: readonly AmendmentEntry[],
): WaiverAudit[] {
  return waivers.waivers.map((w) => {
    const citation = resolveCitation(w, amendments);
    const gate = gates.gates.find((g) => g.id === w.gate) ?? null;
    return {
      gate: w.gate,
      amendment: w.amendment,
      amendmentTitle: w.amendmentTitle,
      amendmentStatus: citation.entry?.status ?? 'UNRESOLVED',
      amendmentResolvesUniquely: citation.entry !== null,
      expires: w.expires,
      ceiling: w.ceiling,
      ceilingBasis: w.ceilingBasis,
      scenarios: w.scenarios === null ? null : [...w.scenarios],
      reason: w.reason,
      gateFailed: gate !== null && !gate.pass,
    };
  });
}

/** Human-readable block, printed by both `cli.ts` and `gate.ts`. */
export function formatEvaluation(evaluation: Evaluation, allowFailure: boolean): string {
  const lines: string[] = [];
  const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  lines.push('');
  lines.push('GATE VERDICT');
  for (const o of evaluation.outcomes) {
    lines.push(`  ${pad(o.status, 11)}${o.id}`);
    if (o.why !== '') lines.push(`               ${o.why}`);
  }
  for (const u of evaluation.unused) {
    lines.push(`  ${pad('UNUSED', 11)}${u.waiver.gate}`);
    lines.push(`               ${u.why}`);
  }
  const failed = evaluation.outcomes.filter((o) => o.status === 'FAIL');
  lines.push('');
  if (failed.length === 0) {
    lines.push('GATES: no unwaived failure.');
  } else if (allowFailure) {
    lines.push(
      `GATES: ${failed.length} unwaived failure(s) — ${failed.map((f) => f.id).join(', ')}. ` +
        'Exit code suppressed by --allow-failure.',
    );
  } else {
    lines.push(
      `GATES: ${failed.length} unwaived failure(s) — ${failed.map((f) => f.id).join(', ')}. Build FAILS.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
