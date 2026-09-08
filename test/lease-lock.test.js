import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { basename, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { acquireLease, LEASE_MAX_MS, leaseOwned, releaseLease, RELEASE_TOTAL_WAIT_MS, renewLease } from '../lib/lease-lock.js';
import { leaseExpired, FUTURE_SKEW_TOLERANCE_MS } from '../lib/lease-clock.js';

const fixtures = new Set();

afterEach(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
  fixtures.clear();
});

function spinWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous settle */ }
}

// Restores a sabotaged fence directory's mode after a fixed delay, from an
// independent thread that keeps running while the test thread is blocked
// inside the library's synchronous retry loops.
const RESTORE_MODE_WORKER_SOURCE = `
const { chmodSync } = require('node:fs');
const { workerData } = require('node:worker_threads');
const deadline = Date.now() + workerData.delayMs;
(function poll() {
  if (Date.now() >= deadline) {
    try { chmodSync(workerData.fenceDir, workerData.mode); } catch { /* removed concurrently */ }
    return;
  }
  setTimeout(poll, 5);
})();
`;

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

  it('converges through terminal disposal when the fence removal is rejected', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-fence-resume-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    let claimRemovals = 0;
    const testInterlock = (phase, stage) => {
      if (phase !== 'lease-release') return;
      if (stage === 'vacancy') {
        // The fence rename just happened, so lease.path is vacant and exactly
        // one `.taken-` entry sits beside it. Contaminate the fence so the
        // single removal attempt fails the stray-entry guard.
        const taken = readdirSync(home).find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
        assert.ok(taken, 'fence directory must exist after the vacancy interlock');
        writeFileSync(join(home, taken, 'stray'), 'stray');
      } else if (stage === 'claim-removal') {
        claimRemovals += 1;
      }
    };
    const lease = acquireLease(leasePath, { testInterlock });
    assert.notEqual(lease, null);
    if (!lease) return;

    const released = releaseLease(lease);
    assert.equal(released, true, 'a rejected fence removal must converge through terminal disposal at the fence');
    assert.equal(claimRemovals, 1, 'the removal must run at the fence exactly once; the retry loop is gone by design');
    const quarantineRoot = join(home, '.cah-lease-quarantine');
    const quarantined = readdirSync(quarantineRoot)
      .find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.ok(quarantined, 'the rejected fence body must be quarantined beside the lease path');
    assert.equal(readdirSync(join(quarantineRoot, quarantined)).includes('stray'), true,
      'quarantine must preserve the fence contents that blocked the removal');
    const leftover = readdirSync(home).filter((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.equal(leftover.length, 0, 'no stranded fence entry may remain beside the lease path');
    assert.equal(existsSync(leasePath), false, 'lease directory must be gone after release');

    const successor = acquireLease(leasePath);
    assert.notEqual(successor, null, 'a quarantined fence must not block a later acquire');
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

  it('disposes of its own owner-file-only fence when the owner unlink fails and quarantines the body', () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-owner-unlink-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    let claimRemovalCalls = 0;
    const testInterlock = (phase, stage) => {
      if (phase !== 'lease-release') return;
      if (stage === 'claim-removal') {
        claimRemovalCalls += 1;
        if (claimRemovalCalls !== 1) return;
        // The fence rename already happened (takeFence's vacancy snapshot
        // check requires owner.json to still be a readable file, so the
        // sabotage must land at the first removal attempt instead). Replace
        // owner.json with a same-named
        // DIRECTORY: every removal attempt then fails unlinkSync with a
        // non-transient code (EISDIR on POSIX; on Windows EPERM, which is
        // transient here and exhausts the whole removal budget). The fence is
        // left holding only owner.json — a shape the stray-entry guard in
        // removeClaimPath never sees, so no retry or quarantine precondition
        // keyed on "unexpected contents" can resolve it.
        const taken = readdirSync(home).find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
        assert.ok(taken, 'fence directory must exist at the first removal interlock');
        const fenceDir = join(home, taken);
        unlinkSync(join(fenceDir, 'owner.json'));
        mkdirSync(join(fenceDir, 'owner.json'));
      }
    };
    const lease = acquireLease(leasePath, { testInterlock });
    assert.notEqual(lease, null);
    if (!lease) return;

    const released = releaseLease(lease);
    assert.equal(released, true, 'a self-owned fence holding only owner.json must be disposed of, not stranded beside the claim path');
    assert.ok(claimRemovalCalls >= 1, 'the owner unlink failure must be reached for this repro to be meaningful');
    assert.equal(existsSync(leasePath), false, 'lease directory must be gone after release');
    const quarantineRoot = join(home, '.cah-lease-quarantine');
    const quarantined = readdirSync(quarantineRoot)
      .find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.ok(quarantined, 'the undisposed fence body must be quarantined beside the lease path');
    assert.equal(existsSync(join(quarantineRoot, quarantined, 'owner.json')), true,
      'quarantine must preserve the fence contents');
    const leftover = readdirSync(home).filter((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.equal(leftover.length, 0, 'no stranded `.taken-` fence entry may remain beside the lease path');

    const successor = acquireLease(leasePath);
    assert.notEqual(successor, null, 'a quarantined fence must not block a later same-process acquire');
    if (successor) releaseLease(successor);
  });

  it('bounds a fully-contended release to the documented ceiling and disposes of the spent fence', function () {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-release-ceiling-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    const posix = process.platform !== 'win32';
    let fenceDir = null;
    let claimRemovals = 0;
    let restoreWorker = null;
    const testInterlock = (phase, stage) => {
      if (phase !== 'lease-release') return;
      if (stage === 'claim-removal') {
        claimRemovals += 1;
        if (claimRemovals !== 1) return;
        const taken = readdirSync(home).find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
        assert.ok(taken, 'fence directory must exist at the first removal interlock');
        fenceDir = join(home, taken);
        if (posix) {
          // POSIX: a read-only fence directory makes unlinkSync fail with
          // EACCES (transient), genuinely spending the removal share. An
          // independent worker thread restores the mode ~50ms into the
          // disposal share (the removal share is 250ms of the documented
          // 1250ms total), which must still converge on its own fresh budget.
          chmodSync(fenceDir, 0o555);
          restoreWorker = new Worker(RESTORE_MODE_WORKER_SOURCE, {
            eval: true, workerData: { fenceDir, delayMs: 300, mode: 0o755 },
          });
        } else {
          // Replace owner.json with a same-named DIRECTORY: every unlink in
          // the removal share fails with EPERM (transient) until that share
          // expires, and the disposal must still converge on its own fresh share.
          unlinkSync(join(fenceDir, 'owner.json'));
          mkdirSync(join(fenceDir, 'owner.json'));
        }
      }
    };
    const lease = acquireLease(leasePath, { testInterlock });
    assert.notEqual(lease, null);
    if (!lease) return;

    try {
      const startedAt = Date.now();
      const released = releaseLease(lease);
      const elapsed = Date.now() - startedAt;
      assert.equal(released, true, 'the disposal fallback must converge on its own fresh share after the removal share is spent');
      assert.equal(claimRemovals, 1, 'the removal is one genuine attempt, not a decorative retry loop');
      if (posix) {
        assert.ok(elapsed >= 250,
          `the transient obstruction must genuinely spend the removal share, got ${elapsed}ms`);
      }
      assert.ok(
        elapsed < RELEASE_TOTAL_WAIT_MS + 250,
        `a fully-contended release must stay bounded by the documented ${RELEASE_TOTAL_WAIT_MS}ms ceiling, got ${elapsed}ms`,
      );
      const leftover = readdirSync(home).filter((name) => name.startsWith(`${basename(leasePath)}.taken-`));
      assert.equal(leftover.length, 0, 'no stranded `.taken-` fence entry may remain beside the lease path');

      const successor = acquireLease(leasePath);
      assert.notEqual(successor, null, 'the disposed fence must not block a later same-process acquire');
      if (successor) releaseLease(successor);
    } finally {
      if (restoreWorker) restoreWorker.terminate();
      try { if (fenceDir && existsSync(fenceDir)) chmodSync(fenceDir, 0o755); } catch { /* best effort */ }
    }
  });

  it('disposes of a reclaimed expired-claim fence holding a stray entry and lets the acquire proceed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-reclaim-stray-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');
    // A genuinely dead pid, exactly the expired state the reclaim exists to clear.
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.once('exit', resolve));
    mkdirSync(leasePath);
    writeFileSync(join(leasePath, 'owner.json'), `${JSON.stringify({
      pid: dead.pid, token: 'reclaim-me', generation: 'reclaim-gen', timestamp: Date.now(),
    })}\n`);
    writeFileSync(join(leasePath, 'stray'), 'stray');

    const lease = acquireLease(leasePath);
    assert.notEqual(lease, null, 'a stray entry inside an expired claim must not fail the reclaim');
    const leftover = readdirSync(home).filter((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.equal(leftover.length, 0, 'the rejected removal must not strand a `.taken-` fence beside the claim');
    const quarantineRoot = join(home, '.cah-lease-quarantine');
    const quarantined = readdirSync(quarantineRoot)
      .find((name) => name.startsWith(`${basename(leasePath)}.taken-`));
    assert.ok(quarantined, 'the displaced expired claim must be quarantined for reporting');
    assert.equal(readdirSync(join(quarantineRoot, quarantined)).includes('stray'), true,
      'quarantine must preserve the stray entry that blocked the plain removal');
    assert.equal(leaseOwned(lease), true, 'the reclaimed lease must be owned');
    assert.equal(releaseLease(lease), true, 'the reclaimed lease must be releasable');
    assert.equal(existsSync(leasePath), false, 'lease directory must be gone after release');
  });
});

// A crashed reclaim leaves a `.taken-<deadpid>-<uuid>` fence and an expired
// claim — exactly what a SIGKILLed hook leaves between takeFence()'s rename
// and its disposal. When several real acquirers race to recover it, the
// loser that displaces the current claim into `.abandoned-<pid>-<uuid>` and
// then loses the fence restore used to return without disposing that
// displacement, silently and permanently. Round 68: every exit path must
// dispose.
describe('recoverFence displacement disposal under real contention', () => {
  it('leaves no .abandoned- displacement behind when real acquirers race a crashed fence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cah-lease-abandoned-'));
    fixtures.add(home);
    const leasePath = join(home, 'claim');

    // A genuinely dead pid for the planted crashed state.
    const corpse = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((resolve) => corpse.once('exit', resolve));
    const deadPid = corpse.pid;

    const owner = `${JSON.stringify({
      pid: deadPid,
      token: 'planted-token',
      generation: 'planted-generation',
      timestamp: Date.now() - 60_000,
    })}\n`;
    mkdirSync(leasePath);
    writeFileSync(join(leasePath, 'owner.json'), owner);
    const plantedFence = `${leasePath}.taken-${deadPid}-plantedfence`;
    mkdirSync(plantedFence);
    writeFileSync(join(plantedFence, 'owner.json'), owner);

    // A 1 ms lease makes every claim instantly expired, so each acquirer
    // iteration goes through takeFence/recoverFence against live peers —
    // the production shape of expired-lease contention.
    const acquirerScript = `
      import { acquireLease, releaseLease } from ${JSON.stringify(new URL('../lib/lease-lock.js', import.meta.url).href)};
      const rounds = Number(process.env.CAH_TEST_LEASE_ROUNDS);
      let acquired = 0;
      for (let i = 0; i < rounds; i += 1) {
        const lease = acquireLease(process.env.CAH_TEST_LEASE_PATH, { testLeaseEnv: 'CAH_TEST_LEASE_MS' });
        if (lease) {
          acquired += 1;
          releaseLease(lease);
        }
      }
      process.stdout.write('DONE ' + String(acquired) + '\\n');
    `;
    const children = [];
    for (let i = 0; i < 4; i += 1) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', acquirerScript], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CAH_TEST_ONLY: '1',
          CAH_TEST_LEASE_MS: '1',
          CAH_TEST_LEASE_PATH: leasePath,
          CAH_TEST_LEASE_ROUNDS: '100',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      children.push(new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr }))));
    }
    const results = await Promise.all(children);
    for (const [index, result] of results.entries()) {
      assert.equal(result.code, 0,
        `acquirer ${index} failed: ${result.stdout} ${result.stderr}`);
    }

    // The displacement namespace must be empty after the race settles:
    // every exit path disposes, so nothing is left silently behind.
    const leftovers = readdirSync(home).filter((name) => name.includes('.abandoned-'));
    assert.deepEqual(leftovers, [],
      `recoverFence() leaked its displacement quarantine: ${JSON.stringify(leftovers)}`);
  });
});

describe('lease expiry and reclaim agree at every clock boundary', () => {
  const T = 1_700_000_000_000;

  it('expiry, renewal and takeover agree for live and dead owners at every boundary', () => {
    const boundaries = [
      { now: T - FUTURE_SKEW_TOLERANCE_MS - 1, expired: true },
      { now: T - FUTURE_SKEW_TOLERANCE_MS, expired: false },
      { now: T, expired: false },
      { now: T + LEASE_MAX_MS, expired: false },
      { now: T + LEASE_MAX_MS + 1, expired: true },
    ];
    for (const liveness of ['live', 'dead']) {
      const pidIsAlive = () => liveness === 'live';
      for (const { now, expired } of boundaries) {
        const dir = mkdtempSync(join(tmpdir(), 'cah-lease-boundary-'));
        fixtures.add(dir);
        const lease = acquireLease(join(dir, 'claim'), { nowMs: T });
        assert.notEqual(lease, null, `acquire at T must succeed (${liveness}, now=${now})`);
        const diskOwner = JSON.parse(readFileSync(join(dir, 'claim', 'owner.json'), 'utf8'));
        assert.equal(leaseExpired(diskOwner, now), expired,
          `leaseExpired mismatch at boundary now=${now} (${liveness} owner)`);
        assert.equal(renewLease(lease, now), !expired,
          `renewLease mismatch at boundary now=${now} (${liveness} owner)`);
        if (liveness === 'live') {
          const takeover = acquireLease(join(dir, 'claim'), { nowMs: now, pidIsAlive });
          assert.equal(takeover !== null, expired,
            `takeover mismatch at boundary now=${now} (live owner)`);
          if (takeover !== null) {
            assert.equal(leaseOwned(takeover), true,
              `takeover lease must be owned at now=${now} (live owner)`);
            releaseLease(takeover);
          }
        } else {
          const takeover = acquireLease(join(dir, 'claim'), { nowMs: now, pidIsAlive });
          assert.notEqual(takeover, null,
            `dead-owner takeover must succeed at every boundary (now=${now})`);
          assert.equal(leaseOwned(takeover), true,
            `dead-owner takeover lease must be owned (now=${now})`);
          releaseLease(takeover);
        }
      }
    }
  });

  it('a future-dated lease is renewable neither by its owner nor takeable before the fix', () => {
    const T0 = 1_700_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), 'cah-lease-future-'));
    fixtures.add(dir);
    const leasePath = join(dir, 'claim');
    const lease = acquireLease(leasePath, { nowMs: T0 + 3_600_000 });
    assert.notEqual(lease, null);
    const diskOwner = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8'));
    assert.equal(leaseExpired(diskOwner, T0), true,
      'a future-dated heartbeat must read as expired at the rolled-back clock');
    assert.equal(renewLease(lease, T0), false,
      'the owner must NOT be able to renew a future-dated lease after rollback');
    const takeover = acquireLease(leasePath, { nowMs: T0, pidIsAlive: () => true });
    assert.notEqual(takeover, null,
      'an expired-by-heartbeat live-owner lease must be takeable (the P2-1 contradiction)');
    assert.equal(leaseOwned(takeover), true);
    releaseLease(takeover);
  });
});
