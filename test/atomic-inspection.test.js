import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic } from '../lib/fs-atomic.js';
import {
  AtomicInspectionError, captureRegularFileSnapshot, directoryIdentity,
} from '../lib/fs-atomic-identity.js';

function withFault(method, target, fail, action) {
  const original = fs[method];
  let calls = 0;
  fs[method] = function(path, ...args) {
    if (typeof path === 'string' && resolve(path) === resolve(target)) {
      calls++;
      const code = fail(calls);
      if (code) throw Object.assign(new Error('injected inspection failure'), { code });
    }
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return action(); }
  finally { fs[method] = original; syncBuiltinESMExports(); }
}

function fixture(action) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cah-inspection-'));
  try { action(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('indeterminate filesystem inspection', { concurrency: false }, () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    for (const recoverAfterRename of [false, true]) {
      it(`preserves create-only destination on ${code}, recover-after-rename=${recoverAfterRename}`, () => {
        fixture((dir) => {
          const path = join(dir, 'foreign.txt');
          fs.writeFileSync(path, 'FOREIGN ORIGINAL');
          let renamed = false;
          withFault('lstatSync', path, () => recoverAfterRename && renamed ? null : code, () => {
            assert.throws(() => writeFileAtomic(path, 'NEW PAYLOAD', {
              mode: 0o600, expectedDestination: { exists: false },
              testInterlock(phase) {
                if (phase === 'write-after-rename-before-sync') renamed = true;
              },
            }), (error) => error instanceof AtomicInspectionError && error.cause.code === code);
          });
          assert.equal(renamed, false);
          assert.equal(fs.readFileSync(path, 'utf8'), 'FOREIGN ORIGINAL');
          assert.deepEqual(fs.readdirSync(dir), ['foreign.txt']);
        });
      });
    }
  }

  it('retries a transient metadata failure but still refuses an existing destination', () => {
    fixture((dir) => {
      const path = join(dir, 'foreign.txt');
      fs.writeFileSync(path, 'FOREIGN');
      withFault('lstatSync', path, (call) => call === 1 ? 'EPERM' : null, () => {
        assert.throws(() => writeFileAtomic(path, 'NEW', {
          mode: 0o600, expectedDestination: { exists: false },
        }), /managed destination leaf changed concurrently/);
      });
      assert.equal(fs.readFileSync(path, 'utf8'), 'FOREIGN');
    });
  });

  it('creates a genuinely absent file after a transient metadata failure', () => {
    fixture((dir) => {
      const path = join(dir, 'new.txt');
      withFault('lstatSync', path, (call) => call === 1 ? 'EPERM' : null, () => {
        writeFileAtomic(path, 'NEW', { mode: 0o600, expectedDestination: { exists: false } });
      });
      assert.equal(fs.readFileSync(path, 'utf8'), 'NEW');
    });
  });

  it('never represents inaccessible file or directory metadata as absence', () => {
    fixture((dir) => {
      const path = join(dir, 'file.txt');
      fs.writeFileSync(path, 'content');
      withFault('lstatSync', path, () => 'EPERM', () => {
        assert.throws(() => captureRegularFileSnapshot(path), AtomicInspectionError);
      });
      withFault('lstatSync', dir, () => 'EPERM', () => {
        assert.throws(() => directoryIdentity(dir), AtomicInspectionError);
      });
      assert.equal(captureRegularFileSnapshot(join(dir, 'missing')).present, false);
    });
  });

  it('retries transient reads and reports persistent read failures explicitly', () => {
    fixture((dir) => {
      const path = join(dir, 'file.txt');
      fs.writeFileSync(path, 'content');
      withFault('readFileSync', path, (call) => call === 1 ? 'EPERM' : null, () => {
        assert.equal(captureRegularFileSnapshot(path).content.toString(), 'content');
      });
      withFault('readFileSync', path, () => 'EACCES', () => {
        assert.throws(() => captureRegularFileSnapshot(path),
          (error) => error.code === 'ERR_ATOMIC_INSPECTION_FAILED' && error.cause.code === 'EACCES');
      });
    });
  });
});
