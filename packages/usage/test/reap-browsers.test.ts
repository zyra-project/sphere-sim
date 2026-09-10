// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The guards on the browser sweep.
 *
 * `tools/reap-browsers.ts` kills processes. Two smokes can be running at once,
 * so the interesting question is never "does it kill the abandoned one" — it is
 * "does it leave the live one alone", and that question has several separate
 * answers below because it has several separate guards. A sweep that got this
 * wrong would turn a resource leak into a flaky check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MIN_STALE_MS,
  PROFILE_PREFIX,
  descendants,
  killGroup,
  killProcess,
  listProcesses,
  orphans,
  profileOf,
  sameProcess,
  staleProfiles,
  userDataDirOf,
  victims,
} from '../../../tools/reap-browsers.ts';

const TMP = '/tmp';
const MINE = `${TMP}/${PROFILE_PREFIX}aaaaaa`;
const THEIRS = `${TMP}/${PROFILE_PREFIX}bbbbbb`;

/** The argv `smoke-app.ts` spawns, with the profile flag where it really sits. */
function chromium(profile: string): string[] {
  return [
    '/usr/bin/chromium',
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
}

test('a smoke profile is recognised and a developer’s own browser is not', () => {
  assert.equal(profileOf(chromium(THEIRS), TMP), THEIRS);
  assert.equal(profileOf(['/usr/bin/chromium', '--user-data-dir=/home/me/.config/chromium'], TMP), null);
  assert.equal(profileOf(['/usr/bin/chromium'], TMP), null);
  // Under the temp directory but not one of ours: somebody else's tool.
  assert.equal(profileOf(['/usr/bin/chromium', `--user-data-dir=${TMP}/puppeteer_dev_x`], TMP), null);
});

test('a temp directory with a space in it is read whole', () => {
  // `os.tmpdir()` is `$TMPDIR` and may contain a space. A first version joined
  // argv with spaces and took the flag's value up to the next one, and the
  // truncation was not symmetrical between the two readers, which is what made
  // it dangerous rather than merely useless: `profileOf` compared a truncated
  // value against the full prefix and missed the orphan, while `staleProfiles`
  // recorded the same truncated value as the directory a LIVE process was using
  // -- so the live run's real profile matched nothing, counted as unowned, and
  // was deleted out from under it.
  const tmp = '/var/tmp/my dir';
  const live = `${tmp}/${PROFILE_PREFIX}AAAAAA`;
  assert.equal(profileOf(chromium(live), tmp), live);
  const procs = [{ pid: 7, ppid: 999, argv: chromium(live) }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: live, mtimeMs: 0 }], procs, keep: [], now: 1e12 }),
    [],
    'a live run’s profile was deleted because its path contains a space',
  );
});

test('the flag is one argument, not the rest of the line', () => {
  // `--user-data-dir` is not last: `about:blank` follows it.
  assert.equal(userDataDirOf(chromium(THEIRS)), THEIRS);
  assert.equal(userDataDirOf(['/usr/bin/chromium', '--headless=new']), null);
});

test('a browser whose parent is alive is left alone', () => {
  // THE ONE THAT MATTERS. Two smokes can run at once; the other run's browser
  // has that run's node process as its parent. Killing it would fail somebody
  // else's check with a message about a browser that died.
  const live = { pid: 4242, ppid: 999, argv: chromium(THEIRS) };
  assert.deepEqual(orphans({ procs: [live], tmp: TMP, selfPid: 100, keep: [] }), []);
});

test('a browser reparented to init is reclaimed', () => {
  const dead = { pid: 4242, ppid: 1, argv: chromium(THEIRS) };
  assert.deepEqual(
    orphans({ procs: [dead], tmp: TMP, selfPid: 100, keep: [] }).map((p) => p.pid),
    [4242],
  );
});

test('this run’s own profile is never swept', () => {
  // Belt and braces: our own browser has us as its parent so the rule above
  // already spares it. `keep` is what holds if this is ever called from
  // somewhere that has handed the browser off.
  const ours = { pid: 4242, ppid: 1, argv: chromium(MINE) };
  assert.deepEqual(orphans({ procs: [ours], tmp: TMP, selfPid: 100, keep: [MINE] }), []);
});

test('nothing is swept when this process is init', () => {
  // In a container node can be pid 1, and then "reparented to init" and "child
  // of ours" are the same observation. The guard cannot distinguish a live
  // sibling from an abandoned browser, so it declines to guess.
  const p = { pid: 4242, ppid: 1, argv: chromium(THEIRS) };
  assert.deepEqual(orphans({ procs: [p], tmp: TMP, selfPid: 1, keep: [] }), []);
});

test('a reparented process that is not one of ours is not touched', () => {
  const other = {
    pid: 4242,
    ppid: 1,
    argv: ['/usr/bin/chromium', '--user-data-dir=/home/me/.config/chromium'],
  };
  assert.deepEqual(orphans({ procs: [other], tmp: TMP, selfPid: 100, keep: [] }), []);
});

test('a pid reused between the listing and the kill is not the same process', () => {
  // The sweep re-reads a candidate immediately before signalling it, and what it
  // has to establish is IDENTITY, not resemblance: a reused pid can belong to a
  // live concurrent smoke, whose browser also names a smoke profile and would
  // pass any test of the form "does this still look like one of ours".
  const was = { pid: 4242, ppid: 1, argv: chromium(THEIRS) };
  assert.ok(sameProcess({ ...was }, was));
  // A live sibling's browser that inherited the pid: different profile, and a
  // parent that is alive.
  assert.ok(!sameProcess({ pid: 4242, ppid: 900, argv: chromium(MINE) }, was));
  // Same profile, live parent — the parentage alone must settle it.
  assert.ok(!sameProcess({ pid: 4242, ppid: 900, argv: chromium(THEIRS) }, was));
  // Same parent, different argv — a different program that inherited the pid.
  assert.ok(!sameProcess({ pid: 4242, ppid: 1, argv: ['/bin/sh'] }, was));
  // Argv of the same length but not the same content.
  assert.ok(!sameProcess({ pid: 4242, ppid: 1, argv: chromium(MINE) }, was));
});

test('a legacy browser’s renderers are found, however deep', () => {
  // A browser the pre-signal-handler smoke spawned leads no process group, so a
  // group kill falls back to the single process and leaves its renderers and GPU
  // process -- the expensive half -- to be reparented. The sweep walks the tree
  // by hand for that reason, so the walk has to reach all of it.
  const procs = [
    { pid: 10, ppid: 1, argv: chromium(THEIRS) },
    { pid: 11, ppid: 10, argv: ['chrome', '--type=zygote', `--user-data-dir=${THEIRS}`] },
    { pid: 12, ppid: 11, argv: ['chrome', '--type=renderer', `--user-data-dir=${THEIRS}`] },
    { pid: 13, ppid: 10, argv: ['chrome', '--type=gpu-process', `--user-data-dir=${THEIRS}`] },
    { pid: 99, ppid: 1, argv: ['/bin/bash'] },
  ];
  assert.deepEqual(
    descendants(10, procs).map((p) => p.pid).sort((a, b) => a - b),
    [11, 12, 13],
    'the walk did not reach a grandchild, or wandered outside the tree',
  );
  assert.deepEqual(descendants(99, procs), []);
});

test('an abandoned browser takes everything it started', () => {
  // What the sweep actually signals. A legacy browser is not a group leader, so
  // the group kill degrades to the one process and the renderers -- where the
  // CPU is -- have to be named individually.
  //
  // ON PARENTAGE, NOT ON A SECOND PROFILE MATCH, and the argv below is measured
  // rather than invented: Chromium sets its subprocesses' titles by overwriting
  // the argv memory with ONE string, so a renderer reports a single element
  // holding the whole line as text and nothing under the browser has an argument
  // beginning with `--user-data-dir=`. A version of this that required one
  // excluded every renderer and reclaimed nothing extra at all.
  const blob = (type: string): string[] => [
    `/opt/pw-browsers/chromium-1194/chrome-linux/chrome --type=${type} --user-data-dir=${THEIRS}`,
  ];
  const procs = [
    { pid: 10, ppid: 1, argv: chromium(THEIRS) },
    { pid: 11, ppid: 10, argv: blob('zygote') },
    { pid: 12, ppid: 11, argv: blob('renderer') },
    { pid: 13, ppid: 10, argv: blob('gpu-process') },
  ];
  assert.equal(
    profileOf(procs[1].argv, TMP),
    null,
    'a rewritten subprocess title is not an argument vector and must not read as one',
  );
  // Sorted: the walk is breadth-first, so a grandchild follows both children,
  // and the order it signals in is not a property worth pinning.
  assert.deepEqual(
    victims(procs[0], procs).map((p) => p.pid).sort((a, b) => a - b),
    [10, 11, 12, 13],
    'the sweep would leave renderers running — the half that costs the CPU',
  );
});

test('the descendant walk terminates on a snapshot that contradicts itself', () => {
  // The list is read one file at a time from a moving system, so it need not be
  // a consistent tree. A cycle must not hang the sweep.
  const procs = [
    { pid: 20, ppid: 1, argv: chromium(THEIRS) },
    { pid: 21, ppid: 20, argv: ['chrome'] },
    { pid: 20, ppid: 21, argv: ['chrome'] },
  ];
  assert.deepEqual(descendants(20, procs).map((p) => p.pid), [21]);
});

const NOW = 1_000_000_000;
const OLD = NOW - MIN_STALE_MS - 1;

test('a profile directory no live process names is stale', () => {
  const procs = [{ pid: 7, ppid: 1, argv: ['/bin/bash'] }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: THEIRS, mtimeMs: OLD }], procs, keep: [], now: NOW }),
    [THEIRS],
  );
});

test('a profile directory a live process is using survives', () => {
  const procs = [{ pid: 7, ppid: 999, argv: chromium(THEIRS) }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: THEIRS, mtimeMs: OLD }], procs, keep: [], now: NOW }),
    [],
  );
});

test('a directory younger than the floor survives whoever names it', () => {
  // The window between `mkdtemp` and `spawn`: the directory exists and no
  // process names it yet. Without the floor a concurrent sweep deletes the
  // profile of a run that is about to start using it.
  const procs = [{ pid: 7, ppid: 1, argv: ['/bin/bash'] }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: THEIRS, mtimeMs: NOW - 1000 }], procs, keep: [], now: NOW }),
    [],
  );
});

test('an empty process list deletes nothing at all', () => {
  // `listProcesses` returns nothing where /proc does not exist. "No process
  // names this directory" then stops being a fact about ownership and becomes
  // vacuously true of every directory on the machine, live ones included.
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: THEIRS, mtimeMs: OLD }], procs: [], keep: [], now: NOW }),
    [],
  );
});

test('the calling run’s directory is kept however old it looks', () => {
  const procs = [{ pid: 7, ppid: 1, argv: ['/bin/bash'] }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: MINE, mtimeMs: OLD }], procs, keep: [MINE], now: NOW }),
    [],
  );
});

test('processes are read from a /proc tree, pid, parent and argv', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-fixture-'));
  try {
    const write = (pid: number, ppid: number, argv: string[]): void => {
      const dir = path.join(root, String(pid));
      fs.mkdirSync(dir);
      // A comm containing a space and a parenthesis, which is why the parent is
      // read from `status` rather than by splitting `stat` on whitespace.
      fs.writeFileSync(path.join(dir, 'status'), `Name:\tchrome (x)\nPid:\t${pid}\nPPid:\t${ppid}\n`);
      fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    };
    write(11, 1, chromium(THEIRS));
    write(12, 11, ['/usr/bin/chromium', '--type=renderer']);
    // A kernel thread: no arguments at all, and not a candidate for anything.
    fs.mkdirSync(path.join(root, '13'));
    fs.writeFileSync(path.join(root, '13', 'status'), 'Name:\tkthreadd\nPPid:\t2\n');
    fs.writeFileSync(path.join(root, '13', 'cmdline'), '');
    fs.mkdirSync(path.join(root, 'self'));

    const procs = listProcesses(root);
    assert.deepEqual(
      procs.map((p) => [p.pid, p.ppid]),
      [
        [11, 1],
        [12, 11],
        [13, 2],
      ],
    );
    // The trailing NUL does not become a phantom empty argument.
    assert.deepEqual(procs[0].argv, chromium(THEIRS));
    assert.deepEqual(procs[2].argv, []);
    assert.equal(profileOf(procs[0].argv, TMP), THEIRS);
    // `self` and the other non-numeric entries in a real /proc are not pids.
    assert.ok(!procs.some((p) => Number.isNaN(p.pid)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a /proc that cannot be read yields no processes rather than throwing', () => {
  assert.deepEqual(listProcesses('/nonexistent-proc-for-this-test'), []);
});

test('killing a group takes the children with it, and says whether it did', () => {
  // The claim the tool prints is "reclaimed N abandoned browsers", so a kill
  // that went nowhere must not be counted: a process belonging to another user
  // answers with EPERM, and swallowing that would put a sentence on the screen
  // saying the machine was cleaned up when it was not.
  assert.equal(killGroup(undefined), false);
  // AND A NEGATIVE PID IS REFUSED RATHER THAN NEGATED. This function's job is to
  // turn a pid into a group by negating it, so it is handed -1 and asked to send
  // SIGKILL to process 1. Written as a test of the return value, found as a test
  // that signalled init: the guard is the fix and this is what holds it.
  assert.equal(killGroup(-1), false);
  assert.equal(killGroup(0), false);
  assert.equal(killProcess(-1), false);
  assert.equal(killProcess(0), false);
  assert.equal(killProcess(undefined), false);
});

test('a detached child and its own child both die', async () => {
  // The shape `smoke-app.ts` spawns: detached, so the pid is also the group id,
  // and with a child of its own standing in for a renderer. Killing the leader
  // alone would leave the inner `sleep` running.
  const child = spawn('sh', ['-c', 'sleep 60 & sleep 60'], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(killGroup(pid), true);
  // Waited for rather than asserted on immediately: SIGKILL is instant but the
  // dead stay visible to `kill -0` as zombies until somebody reaps them, and the
  // inner `sleep` is reparented to init to be reaped there.
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(-pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'something in the group outlived the kill');
});
