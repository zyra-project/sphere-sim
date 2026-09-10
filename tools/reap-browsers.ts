// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Chromium does not die with the process that started it.
 *
 * ## The leak
 *
 * `tools/smoke-app.ts` spawns a headless Chromium and kills it in a `finally`.
 * A `finally` runs when the function returns or throws. It does not run when the
 * process is SIGNALLED, and nothing in the tool handled a signal — so Ctrl-C, a
 * cancelled CI job, a container reclaim or an OOM kill each left the browser
 * behind. An orphan is reparented to init and keeps going: swiftshader puts the
 * whole renderer on the CPU, so a survivor sits near half a core indefinitely.
 *
 * This was measured rather than reasoned about. Five abandoned trees were found
 * on one machine at once, each around 40% of a core, while a live smoke sat at
 * its browser-start budget getting nothing done; it advanced ninety seconds
 * after they were killed by hand. The tool was competing with its own wreckage.
 * Fifteen abandoned profile directories were still on the same machine, holding
 * 1.3 GB between them.
 *
 * What signalled those five runs was never established and this module does not
 * claim to know. What is established is the SHAPE: a `kill -9` on the tool
 * reproduces it exactly — nine orphaned processes, the browser reparented to
 * init, a renderer at 41% of a core.
 *
 * ## Two halves, because one of them cannot be complete
 *
 * Signal handlers in `smoke-app.ts` cover every signal that can be caught, which
 * is the common case and the interactive one. They cannot cover SIGKILL, which
 * is what a container reclaim and the OOM killer send and what an impatient
 * operator sends. No process can clean up after its own SIGKILL — the honest
 * answer is not to try, but to make the NEXT run clean up, which is what this
 * module is for.
 *
 * ## Why the guards here are the whole point
 *
 * Two smokes can be running at once: `ci.yml` and `pages.yml` each run one, and
 * a contributor's `npm run ci` can meet a manual run on the same machine. A
 * sweep that could not tell an abandoned browser from a live sibling's would
 * turn a leak into a flake, and a flake in the check that exists to catch shader
 * failures is worse than the leak it fixed. So a candidate is killed only when
 * all of these hold:
 *
 *   - its command line names a `--user-data-dir` under this machine's temp
 *     directory with the prefix `smoke-app.ts` uses, so it is one of ours;
 *   - that directory is not one the calling run owns;
 *   - its parent is init, so the run that started it is gone and nobody living
 *     is responsible for it.
 *
 * The last is the load-bearing one, and it is why this module is separately
 * tested: a browser with a live parent belongs to that parent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The prefix `smoke-app.ts` gives `fs.mkdtempSync`, and so the name to know. */
export const PROFILE_PREFIX = 'sphere-smoke-';

/**
 * How old an abandoned profile directory must be before it is deleted.
 *
 * A run creates its directory and spawns the browser microseconds later. In that
 * window the directory exists and no process names it, which is indistinguisha-
 * ble from abandoned. The floor makes the window unreachable rather than
 * unlikely.
 */
export const MIN_STALE_MS = 5 * 60_000;

export interface Proc {
  pid: number;
  ppid: number;
  /** The full command line, its arguments separated by single spaces. */
  cmdline: string;
}

/**
 * Every process this user can see.
 *
 * `/proc` only, which is Linux only — the empty list everywhere else is not an
 * oversight but the safe answer, and every caller below treats "I know of no
 * processes" as "kill nothing, delete nothing" rather than as "nothing is
 * running".
 */
export function listProcesses(procRoot = '/proc'): Proc[] {
  const out: Proc[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const proc = readProc(procRoot, pid);
    if (proc !== null) out.push(proc);
  }
  return out;
}

/** One process, or null if it went away between the listing and the read. */
function readProc(procRoot: string, pid: number): Proc | null {
  try {
    // `status` rather than `stat`: `stat`'s second field is the executable name
    // in parentheses and may itself contain spaces and parentheses, so its
    // fields cannot be split on whitespace without care. `PPid:` is a line.
    const status = fs.readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
    const m = /^PPid:\s*(\d+)$/m.exec(status);
    if (m === null) return null;
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    return { pid, ppid: Number(m[1]), cmdline: raw.replace(/\0/g, ' ').trim() };
  } catch {
    // Gone, or not ours to read. Either way it is not a candidate.
    return null;
  }
}

/**
 * The smoke profile directory a command line was started with, or null.
 *
 * Null for a browser the developer is running for their own reasons: their
 * profile is not under the temp directory and does not carry the prefix.
 */
export function profileOf(cmdline: string, tmp: string): string | null {
  const flag = '--user-data-dir=';
  const at = cmdline.indexOf(flag);
  if (at < 0) return null;
  const rest = cmdline.slice(at + flag.length);
  // The argument ends at the first space: `mkdtemp` never produces one, and the
  // flag is not last -- `about:blank` follows it, so taking the rest of the line
  // would compare a directory against a string with a URL on the end and match
  // nothing at all, which is the failure that looks like an empty machine.
  const end = rest.indexOf(' ');
  const dir = end < 0 ? rest : rest.slice(0, end);
  return dir.startsWith(path.join(tmp, PROFILE_PREFIX)) ? dir : null;
}

export interface SweepInput {
  procs: readonly Proc[];
  /** Where profiles are made — `os.tmpdir()` in the tool, a fixture in tests. */
  tmp: string;
  /** This process's pid. */
  selfPid: number;
  /** Profile directories the calling run owns. Never swept. */
  keep: readonly string[];
}

/** The abandoned smoke browsers in a process list: nobody's to clean up but ours. */
export function orphans(input: SweepInput): Proc[] {
  // If we are init, then "reparented to init" and "child of this very process"
  // are the same observation, and the guard below cannot tell a live sibling
  // from an abandoned browser. Sweeping nothing is the correct answer to a
  // question that cannot be answered.
  if (input.selfPid === 1) return [];
  const out: Proc[] = [];
  for (const p of input.procs) {
    // A browser whose parent is alive belongs to that parent, and two smokes can
    // be running at once -- the other one's browser is not ours to kill.
    if (p.ppid !== 1) continue;
    const profile = profileOf(p.cmdline, input.tmp);
    if (profile === null) continue;
    if (input.keep.includes(profile)) continue;
    out.push(p);
  }
  return out;
}

export interface StaleInput {
  /** Candidate directories, with the modification time of each. */
  dirs: readonly { path: string; mtimeMs: number }[];
  procs: readonly Proc[];
  keep: readonly string[];
  now: number;
  minAgeMs?: number;
}

/**
 * Profile directories left behind by runs that are gone.
 *
 * Each is a Chromium profile and they are not small. The rule is ownership, not
 * age alone: a directory is stale when no process on this machine names it — the
 * age floor exists only to close the race described at `MIN_STALE_MS`.
 */
export function staleProfiles(input: StaleInput): string[] {
  // WITHOUT A PROCESS LIST THERE IS NO OWNERSHIP TEST, and "no process names
  // this directory" degrades from a fact into a vacuous truth about every
  // directory on the machine — including the one a concurrent run is using.
  // That is the sweep deleting a live run's profile out from under it.
  if (input.procs.length === 0) return [];
  const minAge = input.minAgeMs ?? MIN_STALE_MS;
  const named = new Set<string>();
  for (const p of input.procs) {
    const flag = '--user-data-dir=';
    const at = p.cmdline.indexOf(flag);
    if (at < 0) continue;
    const rest = p.cmdline.slice(at + flag.length);
    const end = rest.indexOf(' ');
    named.add(end < 0 ? rest : rest.slice(0, end));
  }
  return input.dirs
    .filter((d) => !input.keep.includes(d.path))
    .filter((d) => !named.has(d.path))
    .filter((d) => input.now - d.mtimeMs >= minAge)
    .map((d) => d.path);
}

/**
 * SIGKILL a detached child and everything it started.
 *
 * The group, not the process. Chromium's renderers, its GPU process and its
 * zygote are separate processes; killing the browser alone leaves them to be
 * reparented, and they are where the CPU goes. `smoke-app.ts` spawns detached
 * precisely so that the whole tree has one name to be killed by.
 *
 * Returns whether a signal actually went anywhere, because the caller PRINTS
 * what it reclaimed and a process belonging to another user answers `kill` with
 * EPERM. Swallowing that and counting it anyway would put a sentence on the
 * operator's screen saying the machine had been cleaned up when it had not.
 */
export function killGroup(pid: number | undefined): boolean {
  // A NEGATIVE PID IS ALREADY A GROUP, and negating it again names process 1.
  // Nothing here produces one -- `listProcesses` filters them out and a spawned
  // child's pid is positive -- but this function's whole job is to negate its
  // argument and hand it to `kill`, so the one input that turns it into a signal
  // at init is worth refusing by name rather than by luck.
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    // Either it is already gone, it never became a group leader, or it is not
    // ours to signal. The single-process attempt below tells those apart.
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

export interface SweepResult {
  killed: Proc[];
  removed: string[];
  /** One sentence per thing done, for the caller to print. Empty when idle. */
  lines: string[];
}

/**
 * Reclaim what earlier runs left behind. Called at the start of a run.
 *
 * Reports rather than whispers: a leak that is silently cleaned up is a leak
 * nobody fixes, and the count is the evidence that the handlers in
 * `smoke-app.ts` are or are not doing their job.
 */
export function sweep(
  opts: {
    tmp?: string;
    keep?: readonly string[];
    now?: number;
    procRoot?: string;
    minAgeMs?: number;
  } = {},
): SweepResult {
  const tmp = opts.tmp ?? os.tmpdir();
  const keep = opts.keep ?? [];
  const procs = listProcesses(opts.procRoot);
  const killed: Proc[] = [];

  for (const p of orphans({ procs, tmp, selfPid: process.pid, keep })) {
    // Re-read the command line immediately before killing it. Between the
    // listing and here the process may have exited and its pid been reused, and
    // the reused pid is somebody else's process. This closes that window to the
    // width of one `readFileSync`.
    const now = readProc(opts.procRoot ?? '/proc', p.pid);
    if (now === null || profileOf(now.cmdline, tmp) === null) continue;
    if (killGroup(p.pid)) killed.push(p);
  }

  const dirs: { path: string; mtimeMs: number }[] = [];
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const full = path.join(tmp, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) dirs.push({ path: full, mtimeMs: st.mtimeMs });
      } catch {
        // Removed under us by another run's sweep. Fine: the job is done.
      }
    }
  } catch {
    // No temp directory to read is not this tool's problem to report.
  }

  // The processes are gone but the list is the one read before the kills, so a
  // directory a just-killed browser named is still "named" and survives to the
  // next run. That is deliberate: a directory Chromium is still unwinding out of
  // is exactly the one `smoke-app.ts` learned to retry the delete on.
  const removed: string[] = [];
  for (const dir of staleProfiles({ dirs, procs, keep, now: opts.now ?? Date.now(), minAgeMs: opts.minAgeMs })) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Somebody else's to delete, or busy. Next run.
    }
  }

  const lines: string[] = [];
  if (killed.length > 0) {
    lines.push(
      `reclaimed ${killed.length} abandoned browser${killed.length === 1 ? '' : 's'} ` +
        `(pid ${killed.map((p) => p.pid).join(', ')}) left by an earlier run`,
    );
  }
  if (removed.length > 0) {
    lines.push(`removed ${removed.length} stale profile director${removed.length === 1 ? 'y' : 'ies'}`);
  }
  return { killed, removed, lines };
}
