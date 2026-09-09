import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  acquireSettingsLock, releaseSettingsLock, settingsLockPath, settingsLockOwned,
  SETTINGS_LOCK_FENCE_SUFFIX,
} from '../lib/settings-lock.js';
import { acquireLease, releaseLease, renewLease } from '../lib/lease-lock.js';
import { enableProbe, ProbeBusyError } from '../lib/probe.js';

function fixture(action) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-settings-fences-'));
  try { action(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('shared settings fence namespace', () => {
  for (const legacy of [false, true]) {
    it(`blocks probe while a ${legacy ? 'legacy' : 'current'} owner renews`, () => {
      fixture((dir) => {
        const settingsPath = join(dir, 'settings.json');
        writeFileSync(settingsPath, '{}\n');
        let contested = false;
        const options = {
          testInterlock(phase, step) {
            if (phase !== 'lease-renew' || step !== 'vacancy') return;
            contested = true;
            assert.throws(() => enableProbe({
              settingsPath, backupPath: join(dir, 'backup.json'),
              logPath: join(dir, 'log'), probeBinAbsPath: join(dir, 'probe.js'),
            }), ProbeBusyError);
          },
        };
        const handle = legacy ? null : acquireSettingsLock(settingsPath, { ...options, deadlineMs: 0 });
        const lease = legacy
          ? acquireLease(settingsLockPath(settingsPath), { ...options, fenceSuffix: '.stale.' })
          : handle.lease;
        assert.ok(lease);
        try {
          const path = join(lease.path, 'owner.json');
          const owner = JSON.parse(readFileSync(path, 'utf8'));
          owner.timestamp = Date.now() - 180000;
          writeFileSync(path, JSON.stringify(owner));
          assert.equal(renewLease(lease), true);
          assert.equal(contested, true);
          if (handle) assert.equal(settingsLockOwned(handle), true);
          assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {});
          assert.equal(existsSync(join(dir, 'backup.json')), false);
          assert.equal(existsSync(join(dir, 'log')), false);
        } finally {
          if (handle) releaseSettingsLock(handle);
          else releaseLease(lease);
        }
      });
    });
  }

  it('rejects a conflicting writer namespace before creating filesystem state', () => {
    fixture((dir) => {
      const settings = join(dir, 'settings.json');
      assert.throws(() => acquireSettingsLock(settings, { fenceSuffix: '.other-' }), TypeError);
      assert.equal(existsSync(settingsLockPath(settings)), false);
      const handle = acquireSettingsLock(settings, { fenceSuffix: SETTINGS_LOCK_FENCE_SUFFIX, deadlineMs: 0 });
      assert.ok(handle);
      releaseSettingsLock(handle);
    });
  });

  it('recovers an abandoned legacy fence using its own operator-pid format', () => {
    fixture((dir) => {
      const settings = join(dir, 'settings.json');
      const lock = settingsLockPath(settings);
      const old = acquireLease(lock, { fenceSuffix: '.stale.' });
      assert.ok(old);
      const fence = lock + '.stale.' + process.pid + '-' + randomUUID();
      renameSync(lock, fence);
      const handle = acquireSettingsLock(settings, { deadlineMs: 0, pidIsAlive: () => false });
      assert.ok(handle);
      try {
        assert.equal(existsSync(fence), false);
        assert.notEqual(handle.generation, old.generation);
        assert.equal(releaseLease(old), false);
        assert.equal(settingsLockOwned(handle), true);
      } finally { releaseSettingsLock(handle); }
    });
  });
});
