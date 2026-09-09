import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { enableProbe, disableProbe, ProbeLeaseLostError } from '../lib/probe.js';
import { settingsLockPath } from '../lib/settings-lock.js';

const original = { type: 'command', command: 'original-user-command' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cah-probe-rollback-lease-'));
  const paths = {
    settingsPath: join(dir, 'settings.json'), backupPath: join(dir, 'backup.json'),
    logPath: join(dir, 'probe.log'), probeBinAbsPath: join(dir, 'probe.js'),
  };
  writeFileSync(paths.settingsPath, JSON.stringify({ statusLine: original }));
  return { dir, paths };
}

describe('probe rollback lease and backup guards', () => {
  it('stops a stale rollback before it can remove the successor stop backup', async () => {
    const { dir, paths } = fixture();
    const shared = new SharedArrayBuffer(8);
    const gate = new Int32Array(shared);
    const probeUrl = new URL('../lib/probe.js', import.meta.url).href;
    let worker, done, bResult, workerError, failure, ready, backupAfterA;
    let started = false, thrown = false;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const gate = new Int32Array(workerData.shared);
      (async () => {
        const { disableProbe } = await import(workerData.probeUrl);
        let result;
        try {
          disableProbe(workerData.paths, {
            testInterlock(phase) {
              if (phase !== 'disable-post-settings-rename') return;
              Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
              if (Atomics.wait(gate, 1, 0, 15000) === 'timed-out') throw new Error('parent resume timed out');
            },
          });
          result = { ok: true };
        } catch (error) { result = { ok: false, name: error.name, message: error.message }; }
        if (Atomics.load(gate, 0) === 0) { Atomics.store(gate, 0, -1); Atomics.notify(gate, 0); }
        parentPort.postMessage(result);
        parentPort.close();
      })().catch((error) => {
        Atomics.store(gate, 0, -1); Atomics.notify(gate, 0);
        parentPort.postMessage({ ok: false, message: error.message }); parentPort.close();
      });
    `;
    try {
      try {
        enableProbe(paths, {
          testInterlock(phase) {
            if (phase === 'enable-post-settings-rename' && !thrown) {
              thrown = true;
              throw new Error('start enable rollback');
            }
            if (phase !== 'probe-rollback-before-final' || started) return;
            started = true;
            const ownerPath = join(settingsLockPath(paths.settingsPath), 'owner.json');
            const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
            owner.timestamp = Date.now() - 3600000;
            writeFileSync(ownerPath, JSON.stringify(owner));
            worker = new Worker(workerSource, { eval: true, workerData: { shared, paths, probeUrl } });
            worker.on('message', (message) => { bResult = message; });
            worker.on('error', (error) => {
              workerError = error; Atomics.store(gate, 0, -1); Atomics.notify(gate, 0);
            });
            done = new Promise((resolve) => worker.once('exit', resolve));
            Atomics.wait(gate, 0, 0, 10000);
          },
        });
      } catch (error) { failure = error; }
      ready = Atomics.load(gate, 0);
      backupAfterA = existsSync(paths.backupPath);
      Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
      if (done) await done;
      assert.equal(workerError, undefined);
      assert.equal(ready, 1, 'successor must reach the post-rename boundary');
      assert.ok(failure instanceof ProbeLeaseLostError, failure?.stack);
      assert.equal(backupAfterA, true, 'stale owner must preserve the backup the successor still needs');
      assert.deepEqual(bResult, { ok: true });
      assert.deepEqual(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).statusLine, original);
      assert.equal(existsSync(paths.backupPath), false, 'successful successor stop consumes the backup');
    } finally {
      Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
      if (worker) await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const boundary of ['disable-post-settings-rename', 'probe-rollback-before-final']) {
    it(`does not reactivate probe after backup disappears at ${boundary}`, () => {
      const { dir, paths } = fixture();
      try {
        enableProbe(paths);
        assert.throws(() => disableProbe(paths, {
          testInterlock(phase) {
            if (phase === boundary) unlinkSync(paths.backupPath);
            if (boundary === 'probe-rollback-before-final' && phase === 'disable-post-settings-rename') {
              throw new Error('start stop rollback');
            }
          },
        }));
        assert.deepEqual(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).statusLine, original);
        assert.equal(existsSync(paths.backupPath), false);
        assert.equal(existsSync(paths.settingsPath + '.cah-owned-publish'), false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
