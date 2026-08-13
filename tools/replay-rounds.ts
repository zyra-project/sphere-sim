/**
 * Rebuild `progress/rounds.json` by replaying every round's ACTUAL code at one
 * fixed seed.
 *
 * ## Why this exists
 *
 * `packages/bench/src/loop.ts` grew a round recorder in round 4. Rounds 0 to 3
 * predate it — round 3's critic found that `progress/rounds.json` did not exist
 * at all, and that "the ranking machinery three rounds have now edited has never
 * recorded a round". Their `bench-results.json` files were gitignored and
 * overwritten on every run, so there was nothing to backfill from, and the
 * progress page rendered a trend section and a before/after section against a
 * single data point.
 *
 * Rather than relabel the page, this replays each round: check the commit out in
 * a worktree, run its own bench at ONE fixed seed and scenario count, and record
 * the result through `recordRound` so the schema, the movement classification and
 * the best-tracking are the loop's own rather than a second implementation.
 *
 * ## The precondition, which is the whole argument
 *
 * A fixed-seed comparison across commits is only meaningful if the seed still
 * selects the same work. Verified in git before this was written:
 *
 *   - `packages/bench/src/scenarios.ts` has been touched EXACTLY ONCE, in
 *     `bcf087e`, the commit that created the bench. Scenario generation,
 *     archetypes and misalignment magnitudes have not moved since.
 *   - `packages/sim/src/scene.ts` has three touches. `29b3df6` created it,
 *     `147af8c` moved `nominalTransfer` into `photometry.ts` and read the slot
 *     table from `conventions.ts` without changing a value, and `941275e` edited
 *     one comment (an amendment renumbering, A-14 to A-19).
 *
 * So seed 771003 means the same scenarios and the same truth rig at every commit
 * below: the same photographs, a different solver. If either file ever changes
 * behaviourally, THIS SCRIPT STOPS BEING VALID for commits spanning the change,
 * and the series it produces would be comparing different work. Re-verify before
 * extending the list.
 *
 * ## What it is not
 *
 * These rounds were replayed, not captured live. Every record carries
 * `provenance: 'replayed'` and the page says so, because a reader must be able to
 * tell a measurement taken at the time from one reconstructed afterwards — even
 * when, as here, the reconstruction is the more controlled of the two.
 *
 * Usage:  node tools/replay-rounds.ts [--seed N] [--scenarios N] [--out FILE]
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordRound, loadHistory, TRACKED } from '../packages/bench/src/loop.ts';
import type { RoundHistory } from '../packages/bench/src/loop.ts';
import type { BenchResults } from '../packages/bench/src/results.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One round, its commit, and what shipped in it. Order is the loop's order. */
const ROUNDS: { round: number; commit: string; shipped: string }[] = [
  { round: 0, commit: 'bcf087e', shipped: 'baseline — the bench exists, solver as first built' },
  { round: 1, commit: '932898f', shipped: 'pooled decode noise estimate' },
  { round: 2, commit: 'cebf5c6', shipped: 'null result — both knobs measured and left off' },
  { round: 3, commit: '6c0923d', shipped: 'differential u/v camera pose' },
  { round: 4, commit: '0aa8980', shipped: 'LK935 hardware envelope and shared-lens tie' },
];

/** Files whose behavioural change would invalidate a cross-commit replay. */
const MUST_BE_STABLE = ['packages/bench/src/scenarios.ts', 'packages/sim/src/scene.ts'];

function parseArgs(argv: readonly string[]): { seed: number; scenarios: number; out: string } {
  let seed = 771003;
  let scenarios = 6;
  let out = path.join(ROOT, 'progress', 'rounds.json');
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--seed' && next) seed = Number(next);
    else if (argv[i] === '--scenarios' && next) scenarios = Number(next);
    else if (argv[i] === '--out' && next) out = path.resolve(next);
  }
  return { seed, scenarios, out };
}

/**
 * Refuse to run if the precondition has quietly stopped holding.
 *
 * Counts commits touching each stability-critical file between the first and
 * last round. A bare count is a blunt instrument — it cannot tell a comment from
 * a magnitude — so it prints what it found and asks for a human read rather than
 * silently proceeding on a number.
 */
function checkPrecondition(): string[] {
  const first = ROUNDS[0].commit;
  const last = ROUNDS[ROUNDS.length - 1].commit;
  const notes: string[] = [];
  for (const file of MUST_BE_STABLE) {
    const log = execFileSync('git', ['log', '--oneline', `${first}..${last}`, '--', file], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const n = log === '' ? 0 : log.split('\n').length;
    notes.push(`${file}: ${n} commit(s) between ${first} and ${last}`);
    if (n > 0) {
      console.warn(`\n  NOTE  ${file} changed ${n} time(s) inside the replay range:`);
      for (const line of log.split('\n')) console.warn(`          ${line}`);
      console.warn(
        '        A comment or a pure refactor is fine. A change to scenario\n' +
          '        generation, archetype definitions or misalignment magnitudes is\n' +
          '        NOT — the seed would select different work per commit and the\n' +
          '        series would compare different things. Read the diff.\n',
      );
    }
  }
  return notes;
}

function replay(commit: string, seed: number, scenarios: number, outFile: string): BenchResults {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), `replay-${commit}-`));
  try {
    execFileSync('git', ['worktree', 'add', '-f', '--detach', wt, commit], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    // The worktree has no node_modules; the bench needs none at runtime, but
    // symlinking keeps any dev-time import resolving the same way it did.
    try {
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(wt, 'node_modules'));
    } catch {
      /* already present, or unsupported — the bench has zero runtime deps */
    }
    // Flags arrived at different commits. Probe rather than assume.
    const cli = fs.readFileSync(path.join(wt, 'packages/bench/src/cli.ts'), 'utf8');
    const flags = ['--no-artifacts', '--quiet'];
    if (cli.includes('allow-failure')) flags.push('--allow-failure');
    if (cli.includes('no-progress')) flags.push('--no-progress');

    execFileSync(
      process.execPath,
      ['packages/bench/src/cli.ts', '--scenarios', String(scenarios), '--seed', String(seed), '--out', outFile, ...flags],
      { cwd: wt, stdio: 'ignore' },
    );
    return JSON.parse(fs.readFileSync(outFile, 'utf8')) as BenchResults;
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'ignore' });
    } catch {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  }
}

function main(): void {
  const { seed, scenarios, out } = parseArgs(process.argv.slice(2));
  console.log(`replay-rounds: ${ROUNDS.length} rounds at seed ${seed}, ${scenarios} scenarios each\n`);
  const notes = checkPrecondition();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-results-'));
  // A fresh history: this REPLACES the recorded history rather than appending to
  // it, because a file mixing replayed and live records with no way to tell them
  // apart is worse than either alone.
  let history: RoundHistory = loadHistory(path.join(tmp, 'none.json'), seed);

  // Pass 1 — replay every round and collect its results.
  const replayed: { spec: (typeof ROUNDS)[number]; results: BenchResults; file: string }[] = [];
  for (const r of ROUNDS) {
    process.stdout.write(`  replay round ${r.round} @ ${r.commit}  ${r.shipped} ... `);
    const started = Date.now();
    const resultsFile = path.join(tmp, `round-${r.round}.json`);
    const results = replay(r.commit, seed, scenarios, resultsFile);
    replayed.push({ spec: r, results, file: resultsFile });
    console.log(`${((Date.now() - started) / 1000).toFixed(0)}s`);
  }

  // Which tracked metrics did EVERY round produce? Rounds 0-2 predate the
  // camera_pose_rotation gate, which round 3 added. Ranking the series on a gate
  // that only exists for part of it would compare a metric against its own
  // absence — so the vector narrows to what is common, and says which it dropped.
  const common = TRACKED.filter((t) =>
    replayed.every(({ results }) => results.gates.gates.some((g) => g.id === t.gateId)),
  ).map((t) => t.key);
  const dropped = TRACKED.filter((t) => !common.includes(t.key));
  if (dropped.length > 0) {
    console.log('\n  ranking on the metrics every round produced; omitted:');
    for (const t of dropped) {
      const firstSeen = replayed.find(({ results }) =>
        results.gates.gates.some((g) => g.id === t.gateId),
      );
      console.log(
        `    ${t.key} — gate '${t.gateId}' first appears in round ` +
          `${firstSeen ? firstSeen.spec.round : 'never'}`,
      );
    }
  }
  console.log('');

  // Pass 2 — rank.
  for (const { spec: r, results, file: resultsFile } of replayed) {
    process.stdout.write(`  round ${r.round}  `);
    const outcome = recordRound(results, history, r.round, seed, 'default', resultsFile, common);
    history = outcome.history;
    const rec = history.rounds[history.rounds.length - 1];
    rec.provenance = 'replayed';
    rec.gitCommit = r.commit;
    rec.shipped = r.shipped;
    rec.resultsPath = `(replayed — ${r.commit})`;
    const grid = outcome.record.series.gridDisplacementMm;
    const pose = outcome.record.series.poseMaxPositionMmAligned;
    console.log(
      `grid worst ${grid?.max.toFixed(3) ?? '—'} mm, pose worst ` +
        `${pose?.max.toFixed(1) ?? '—'} mm — ${outcome.record.comparison.verdict}` +
        `${outcome.record.best ? ' (new best)' : ''}`,
    );
  }

  const doc = history as unknown as Record<string, unknown>;
  doc.provenance = {
    kind: 'replayed',
    why:
      'Rounds 0-3 predate the round recorder, which loop.ts only grew in round 4, ' +
      'and their bench-results files were gitignored and overwritten. Rather than ' +
      'render a trend against one point, each round was replayed: its own commit ' +
      'checked out and its own bench run at one fixed seed.',
    method: `node tools/replay-rounds.ts --seed ${seed} --scenarios ${scenarios}`,
    comparableBecause:
      'Seed selects the same scenarios and the same truth rig at every commit in ' +
      'the range: scenarios.ts is untouched since the bench was created, and ' +
      "scene.ts's later commits are a refactor that moved constants without " +
      'changing them and a one-line comment renumbering. Same photographs, ' +
      'different solver.',
    stabilityCheck: notes,
    rankedOn: common,
    omittedFromRanking: dropped.map((t) => ({
      key: t.key,
      gate: t.gateId,
      why: 'the gate did not exist for every round in the series',
    })),
    caveat:
      'These are replays, not measurements taken at the time. They are the more ' +
      'controlled comparison — one seed, one corpus size — but a reader must be ' +
      'able to tell the two apart, so every record carries provenance: replayed.',
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nwrote ${path.relative(ROOT, out)} — ${history.rounds.length} rounds, best is round ${history.best?.round}`);
}

main();
