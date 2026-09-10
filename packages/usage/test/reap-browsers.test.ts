// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The guards on the browser sweep.
 *
 * `tools/reap-browsers.ts` kills processes. The workflow runs two smokes at
 * once, so the interesting question is never "does it kill the abandoned one"
 * — it is "does it leave the live one alone", and that question has three
 * separate answers below because it has three separate guards. A sweep that got
 * this wrong would turn a resource leak into a flaky check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { spawn } from 'node:child_process';

import {
  MIN_STALE_MS,
  PROFILE_PREFIX,
  killGroup,
  listProcesses,
  orphans,
  profileOf,
  staleProfiles,
} from '../../../tools/reap-browsers.ts';

const TMP = '/tmp';
const MINE = `${TMP}/${PROFILE_PREFIX}aaaaaa`;
const THEIRS = `${TMP}/${PROFILE_PREFIX}bbbbbb`;

/** A command line shaped like the one `smoke-app.ts` spawns. */
function chromium(profile: string): string {
  return `/usr/bin/chromium --headless=new --no-sandbox --use-gl=angle --user-data-dir=${profile} about:blank`;
}

test('a smoke profile is recognised and a developer’s own browser is not', () => {
  assert.equal(profileOf(chromium(THEIRS), TMP), THEIRS);
  assert.equal(profileOf('/usr/bin/chromium --user-data-dir=/home/me/.config/chromium', TMP), null);
  assert.equal(profileOf('/usr/bin/chromium', TMP), null);
  // Under the temp directory but not one of ours: somebody else's tool.
  assert.equal(profileOf(`/usr/bin/chromium --user-data-dir=${TMP}/puppeteer_dev_x`, TMP), null);
});

test('the flag ends at the first space, not at the end of the line', () => {
  // `--user-data-dir` is not the last argument: `about:blank` follows it. A
  // reader that took the rest of the line would compare a directory against a
  // string with a URL stuck on the end and match nothing, and the sweep would
  // quietly never find anything — which is the failure mode that looks like
  // success.
  assert.equal(profileOf(chromium(THEIRS), TMP), THEIRS);
});

test('a browser whose parent is alive is left alone', () => {
  // THE ONE THAT MATTERS. The workflow starts two smokes concurrently; the
  // other run's browser has that run's node process as its parent. Killing it
  // would fail somebody else's check with a message about a browser that died.
  const live = { pid: 4242, ppid: 999, cmdline: chromium(THEIRS) };
  assert.deepEqual(orphans({ procs: [live], tmp: TMP, selfPid: 100, keep: [] }), []);
});

test('a browser reparented to init is reclaimed', () => {
  const dead = { pid: 4242, ppid: 1, cmdline: chromium(THEIRS) };
  assert.deepEqual(
    orphans({ procs: [dead], tmp: TMP, selfPid: 100, keep: [] }).map((p) => p.pid),
    [4242],
  );
});

test('this run’s own profile is never swept', () => {
  // Belt and braces: our own browser has us as its parent so the rule above
  // already spares it. `keep` is what holds if this is ever called from
  // somewhere that has handed the browser off.
  const ours = { pid: 4242, ppid: 1, cmdline: chromium(MINE) };
  assert.deepEqual(orphans({ procs: [ours], tmp: TMP, selfPid: 100, keep: [MINE] }), []);
});

test('nothing is swept when this process is init', () => {
  // In a container node can be pid 1, and then "reparented to init" and "child
  // of ours" are the same observation. The guard cannot distinguish a live
  // sibling from an abandoned browser, so it declines to guess.
  const p = { pid: 4242, ppid: 1, cmdline: chromium(THEIRS) };
  assert.deepEqual(orphans({ procs: [p], tmp: TMP, selfPid: 1, keep: [] }), []);
});

test('a reparented process that is not one of ours is not touched', () => {
  const other = { pid: 4242, ppid: 1, cmdline: '/usr/bin/chromium --user-data-dir=/home/me/.config/chromium' };
  assert.deepEqual(orphans({ procs: [other], tmp: TMP, selfPid: 100, keep: [] }), []);
});

const NOW = 1_000_000_000;
const OLD = NOW - MIN_STALE_MS - 1;

test('a profile directory no live process names is stale', () => {
  const procs = [{ pid: 7, ppid: 1, cmdline: '/bin/bash' }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: THEIRS, mtimeMs: OLD }], procs, keep: [], now: NOW }),
    [THEIRS],
  );
});

test('a profile directory a live process is using survives', () => {
  const procs = [{ pid: 7, ppid: 999, cmdline: chromium(THEIRS) }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: THEIRS, mtimeMs: OLD }], procs, keep: [], now: NOW }),
    [],
  );
});

test('a directory younger than the floor survives whoever names it', () => {
  // The window between `mkdtemp` and `spawn`: the directory exists and no
  // process names it yet. Without the floor a concurrent sweep deletes the
  // profile of a run that is about to start using it.
  const procs = [{ pid: 7, ppid: 1, cmdline: '/bin/bash' }];
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
  const procs = [{ pid: 7, ppid: 1, cmdline: '/bin/bash' }];
  assert.deepEqual(
    staleProfiles({ dirs: [{ path: MINE, mtimeMs: OLD }], procs, keep: [MINE], now: NOW }),
    [],
  );
});

test('processes are read from a /proc tree, pid, parent and command line', () => {
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
    write(11, 1, ['/usr/bin/chromium', `--user-data-dir=${THEIRS}`, 'about:blank']);
    write(12, 11, ['/usr/bin/chromium', '--type=renderer']);
    fs.mkdirSync(path.join(root, 'self'));

    const procs = listProcesses(root);
    assert.deepEqual(
      procs.map((p) => [p.pid, p.ppid]),
      [
        [11, 1],
        [12, 11],
      ],
    );
    // NUL-separated on disk, spaces in hand, so `profileOf` can find the flag.
    assert.equal(profileOf(procs[0].cmdline, TMP), THEIRS);
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
