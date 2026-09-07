import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLease, releaseLease } from '../lib/lease-lock.js';

const fixtures = new Set();

afterEach(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
  fixtures.clear();
});

function spinWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous settle */ }
}

// Windows refuses to rename a directory that a live child process holds as
// its CWD (EBUSY). Other platforms rename it freely, so the repro below can
// only be built where this probe fails to rename.
async function childCwdBlocksRename() {
  const probe = mkdtempSync(join(tmpdir(), 'cah-lease-cwd-probe-'));
  fixtures.add(probe);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120)'], {
    cwd: probe, stdio: 'ignore',
  });
  spinWait(60);
  let blocked = false;
  try {
    renameSync(probe, `${probe}-moved`);
    renameSync(`${probe}-moved`, probe);
  } catch {
    blocked = true;
  }
  await new Promise((resolve) => child.once('exit', resolve));
  return blocked;
}

describe('lease release recovery budget', () => {
  it('retries transient contention with a fresh budget even for a long-held lease', async function () {
    if (!(await childCwdBlocksRename())) {
      return this.skip('platform does not block rename of a directory held as a child process CWD');
    }
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-release-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    const lease = acquireLease(leasePath);
    assert.notEqual(lease, null);
    if (!lease) return;

    // Hold the lease directory as a live child's CWD: the fence rename fails
    // with EBUSY until the child exits, so the release can only succeed by
    // retrying under a freshly computed budget.
    // Hold the lease far longer than the 250 ms recovery window that was
    // stamped into it at acquire time, so only a freshly computed release
    // budget can retry the EBUSY below.
    spinWait(300);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60)'], {
      cwd: leasePath, stdio: 'ignore',
    });
    spinWait(80);
    const released = releaseLease(lease);
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(released, true, 'release must retry transient contention instead of spending the stale acquire-time budget');
    assert.equal(existsSync(leasePath), false, 'lease directory must be removed after a successful release');
  });
});
