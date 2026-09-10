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
 *     is responsible for it;
 *   - and at the moment of the kill it is still the same process: same parent,
 *     same argv. A pid that died between the listing and the signal can be
 *     reused, and a reused pid belonging to a live smoke would also have named a
 *     smoke profile — so "still names a profile" is not the same question and
 *     answering it was not enough.
 *
 * The parentage test is the load-bearing one, and it is why this module is
 * separately tested: a browser with a live parent belongs to that parent.
 *
 * ## Argv is a list, and flattening it was a bug
 *
 * A first version read `/proc/<pid>/cmdline`, replaced its NULs with spaces and
 * scanned the result for `--user-data-dir=`, taking the value up to the next
 * space. `os.tmpdir()` is `$TMPDIR` and may contain a space. When it did, the
 * value came back truncated at that space — and the truncation was not
 * symmetrical between the two readers, which is what made it dangerous rather
 * than merely useless. `profileOf` compared the truncated value against the full
 * prefix, matched nothing, and missed the orphan; `staleProfiles` recorded the
 * same truncated value as the directory a live process was using, so the live
 * run's real profile matched nothing in that set, counted as unowned, and was
 * deleted out from under it once five minutes old.
 *
 * Demonstrated rather than argued: with `tmp` set to `/var/tmp/my dir`, the old
 * `staleProfiles` returned a directory whose owning process was in the very list
 * it had been given. Argv is carried as a list now and the flag's value is one
 * element of it, exactly.
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
  /** The argument vector, one element per argument, never joined. */
  argv: readonly string[];
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
    // NUL-separated on disk and kept that way: see the note on flattening above.
    // The file ends with a NUL, so the last split is empty and is dropped; a
    // kernel thread has an empty `cmdline` and yields no arguments at all.
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    const argv = raw.split('\0').filter((a) => a !== '');
    return { pid, ppid: Number(m[1]), argv };
  } catch {
    // Gone, or not ours to read. Either way it is not a candidate.
    return null;
  }
}

/** The value of `--user-data-dir`, exactly as one argument, or null. */
export function userDataDirOf(argv: readonly string[]): string | null {
  const flag = '--user-data-dir=';
  for (const arg of argv) {
    if (arg.startsWith(flag)) return arg.slice(flag.length);
  }
  return null;
}

/**
 * The smoke profile directory a process was started with, or null.
 *
 * Null for a browser the developer is running for their own reasons: their
 * profile is not under the temp directory and does not carry the prefix.
 */
export function profileOf(argv: readonly string[], tmp: string): string | null {
  const dir = userDataDirOf(argv);
  if (dir === null) return null;
  return dir.startsWith(path.join(tmp, PROFILE_PREFIX)) ? dir : null;
}

/** Whether two readings, taken at different moments, are the same process. */
export function sameProcess(a: Proc, b: Proc): boolean {
  return (
    a.pid === b.pid &&
    a.ppid === b.ppid &&
    a.argv.length === b.argv.length &&
    a.argv.every((arg, i) => arg === b.argv[i])
  );
}

/** Everything below `pid` in a snapshot, however deep. */
export function descendants(pid: number, procs: readonly Proc[]): Proc[] {
  const byParent = new Map<number, Proc[]>();
  for (const p of procs) {
    const kids = byParent.get(p.ppid);
    if (kids === undefined) byParent.set(p.ppid, [p]);
    else kids.push(p);
  }
  const out: Proc[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    for (const kid of byParent.get(queue.shift() as number) ?? []) {
      // A snapshot cannot really contain a cycle, but it is read one file at a
      // time from a moving system and this loop must terminate regardless.
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      out.push(kid);
      queue.push(kid.pid);
    }
  }
  return out;
}

/**
 * Everything one abandoned browser should take with it: itself and its
 * descendants, on the strength of PARENTAGE rather than of a second profile
 * match.
 *
 * A browser the pre-signal-handler smoke spawned leads no process group, so a
 * group kill falls back to the single process and leaves its renderers and GPU
 * process -- the expensive half -- to be reparented; they would be swept on some
 * later run once init had adopted them, which is a leak with a slow fuse rather
 * than a leak fixed.
 *
 * A first version of this required each descendant to name a smoke profile too,
 * on the principle that everything else here kills only what it can positively
 * identify. That filter was INERT, and measuring it is what showed why:
 *
 *   CHROMIUM REWRITES ITS SUBPROCESSES' COMMAND LINES. The browser process has a
 *   real argument vector -- eleven arguments, `--user-data-dir` among them. Its
 *   zygote, GPU process and renderers each report a SINGLE argv element holding
 *   the whole line as text ("…/chrome --type=zygote --no-…"), because Chromium
 *   sets its process title by overwriting that memory with one string. So no
 *   descendant has an argument that begins with `--user-data-dir=`, the filter
 *   excluded every one of them, and the fix killed nothing it had not already.
 *
 * (This is also why an earlier version of this module, which joined the command
 * line with spaces before searching it, appeared to see renderers naming a
 * profile: it was reading the rewritten title as text rather than as arguments.)
 *
 * Parentage is the honest rule and the sound one. Chromium's children are
 * Chromium's; nothing else is under there. And `sweep` re-reads each one
 * immediately before signalling it and requires the same pid, parent and argv,
 * so a pid reused between the snapshot and the kill does not match.
 */
export function victims(candidate: Proc, procs: readonly Proc[]): Proc[] {
  return [candidate, ...descendants(candidate.pid, procs)];
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
    const profile = profileOf(p.argv, input.tmp);
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
  // Every directory anybody is using, ours or not: this set is what stands
  // between a live run and a delete, so it reads the flag from argv exactly and
  // does not care whether the directory looks like one of ours.
  const named = new Set<string>();
  for (const p of input.procs) {
    const dir = userDataDirOf(p.argv);
    if (dir !== null) named.add(dir);
  }
  return input.dirs
    .filter((d) => !input.keep.includes(d.path))
    .filter((d) => !named.has(d.path))
    .filter((d) => input.now - d.mtimeMs >= minAge)
    .map((d) => d.path);
}

/** SIGKILL one process. Returns whether the signal went anywhere. */
export function killProcess(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGKILL a detached child and everything it started.
 *
 * The group, not the process. Chromium's renderers, its GPU process and its
 * zygote are separate processes; killing the browser alone leaves them to be
 * reparented, and they are where the CPU goes. `smoke-app.ts` spawns detached
 * precisely so that the whole tree has one name to be killed by.
 *
 * A browser the OLD smoke spawned is not a group leader, so the group signal
 * fails and this falls back to the one process — which is exactly the behaviour
 * this module exists to fix. `sweep` walks such a tree by hand for that reason.
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
    // ours to signal. The single-process attempt tells those apart.
  }
  return killProcess(pid);
}

export interface SweepResult {
  killed: Proc[];
  /** How many processes died, which is more than one per browser. */
  processes: number;
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
  const root = opts.procRoot ?? '/proc';
  const procs = listProcesses(root);
  const killed: Proc[] = [];
  let processes = 0;

  // Re-read a process immediately before signalling it and require that it is
  // the SAME one: same parent, same argv. Between the listing and here it may
  // have exited and had its pid reused, and a reused pid can belong to a live
  // concurrent smoke -- whose browser also names a smoke profile, so merely
  // asking "does it still look like one of ours" would say yes and kill it.
  const unchanged = (was: Proc): boolean => {
    const now = readProc(root, was.pid);
    return now !== null && sameProcess(now, was);
  };

  for (const p of orphans({ procs, tmp, selfPid: process.pid, keep })) {
    if (!unchanged(p)) continue;
    // The whole tree from the snapshot taken BEFORE the kill: once the browser
    // dies its children are reparented and no longer look like its descendants.
    // For a tree this version spawned the group kill has already taken them and
    // each of these is a no-op that `unchanged` declines.
    let n = killGroup(p.pid) ? 1 : 0;
    for (const d of victims(p, procs)) {
      if (d.pid === p.pid) continue;
      if (!unchanged(d)) continue;
      if (killProcess(d.pid)) n++;
    }
    if (n > 0) {
      killed.push(p);
      processes += n;
    }
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
  for (const dir of staleProfiles({
    dirs,
    procs,
    keep,
    now: opts.now ?? Date.now(),
    minAgeMs: opts.minAgeMs,
  })) {
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
        `(pid ${killed.map((p) => p.pid).join(', ')}, ${processes} ` +
        `process${processes === 1 ? '' : 'es'}) ` +
        'left by an earlier run',
    );
  }
  if (removed.length > 0) {
    lines.push(
      `removed ${removed.length} stale profile director${removed.length === 1 ? 'y' : 'ies'}`,
    );
  }
  return { killed, processes, removed, lines };
}
