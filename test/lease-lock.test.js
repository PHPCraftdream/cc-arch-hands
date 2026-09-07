import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

// Bounded rename-probe loop: rename `dir` aside and immediately back, until
// the rename FAILS — which on Windows (EPERM/EBUSY/ENOTEMPTY) proves the
// child process provably holds the directory (via an open handle / CWD).
// Returns true only
// when the block was actually observed before the ~5s deadline.
function probeUntilRenameBlocked(dir) {
  const probePath = `${dir}.probe`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      renameSync(dir, probePath);
      renameSync(probePath, dir); // rename succeeded: child hasn't taken its CWD yet
      spinWait(5);
    } catch (err) {
      assert.ok(
        ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code),
        `probe rename failed with unexpected code ${err.code} (dir must not have vanished)`,
      );
      return true;
    }
  }
  return false;
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

    // Hold the lease directory via a live child's open handle on a file
    // inside it: Windows refuses to rename a directory with open descendant
    // handles (EPERM/EBUSY) until the handle closes, so the release fence
    // rename can only succeed by retrying under a freshly computed budget.
    // The child unlinks the file and exits ~30 ms after its startup completes,
    // inside the 250 ms recovery window, and removes the file so it never
    // trips the fence's stray-entry guard after takeFence.
    spinWait(300);
    const child = spawn(process.execPath, ['-e', "const p=require('path'),f=require('fs');const q=p.join(process.cwd(),'held');const h=f.openSync(q,'w');setTimeout(() => { try { f.unlinkSync(q); } finally { f.closeSync(h); } }, 30)"], {
      cwd: leasePath, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const blockedOnce = probeUntilRenameBlocked(leasePath);
    assert.ok(blockedOnce, 'probe must prove the first fence rename attempt was blocked by the child\'s open handle (retry is exercised only then)');
    const released = releaseLease(lease);
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(released, true, 'release must retry transient contention instead of spending the stale acquire-time budget');
    assert.equal(existsSync(leasePath), false, 'lease directory must be removed after a successful release');
  });

  it('resumes removal from the fence when the claim path removal fails after takeFence', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-fence-resume-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    let fenceDir = null;
    let claimRemovals = 0;
    const testInterlock = (phase, stage) => {
      if (phase !== 'lease-release') return;
      if (stage === 'vacancy') {
        // The fence rename just happened, so lease.path is vacant and exactly
        // one `.taken-` entry sits beside it. Contaminate the fence so the
        // first removal attempt fails the stray-entry guard.
        const taken = readdirSync(home).find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
        assert.ok(taken, 'fence directory must exist after the vacancy interlock');
        fenceDir = join(home, taken);
        writeFileSync(join(fenceDir, 'stray'), 'stray');
      } else if (stage === 'claim-removal') {
        claimRemovals += 1;
        if (claimRemovals === 2) unlinkSync(join(fenceDir, 'stray'));
      }
    };
    const lease = acquireLease(leasePath, { testInterlock });
    assert.notEqual(lease, null);
    if (!lease) return;

    const released = releaseLease(lease);
    assert.equal(released, true, 'release must retry removal from the fence, not re-enter from the vacant lease.path and strand the fence');
    assert.ok(claimRemovals > 1, 'removal must actually be retried at the fence for this repro to be meaningful');
    const leftover = readdirSync(home).filter((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.equal(leftover.length, 0, 'no stranded fence entry may remain beside the lease path');
    assert.equal(existsSync(leasePath), false, 'lease directory must be gone after release');

    const successor = acquireLease(leasePath);
    assert.notEqual(successor, null, 'a stranded fence must not block a later acquire');
    if (successor) releaseLease(successor);
  });

  it('quarantines its own fence when removal fails non-transiently instead of stranding it', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-fence-quarantine-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    const testInterlock = (phase, stage) => {
      if (phase !== 'lease-release') return;
      if (stage === 'vacancy') {
        // The fence rename just happened, so lease.path is vacant and exactly
        // one `.taken-` entry sits beside it. Contaminate the fence with a
        // stray entry that is never removed: every removal attempt then fails
        // the stray-entry guard, a rejection no retry budget can fix.
        const taken = readdirSync(home).find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
        assert.ok(taken, 'fence directory must exist after the vacancy interlock');
        writeFileSync(join(home, taken, 'stray'), 'stray');
      }
    };
    const lease = acquireLease(leasePath, { testInterlock });
    assert.notEqual(lease, null);
    if (!lease) return;

    const released = releaseLease(lease);
    assert.equal(released, true, 'a non-transiently obstructed fence must be disposed of, not retried identically until the attempts run out');
    assert.equal(existsSync(leasePath), false, 'lease directory must be gone after release');
    const quarantineRoot = join(home, '.cah-lease-quarantine');
    const quarantined = readdirSync(quarantineRoot)
      .find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.ok(quarantined, 'the obstructed fence must be quarantined beside the lease path');
    assert.equal(readdirSync(join(quarantineRoot, quarantined)).includes('stray'), true,
      'quarantine must preserve the fence contents that blocked the removal');
    const leftover = readdirSync(home).filter((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.equal(leftover.length, 0, 'no stranded `.taken-` fence entry may remain beside the lease path');

    const successor = acquireLease(leasePath);
    assert.notEqual(successor, null, 'a quarantined fence must not block a later same-process acquire');
    if (successor) releaseLease(successor);
  });
});
