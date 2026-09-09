import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { captureRegularFileSnapshot, removeOwnedRegularFile } from '../lib/fsutil.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'cah-snapshot-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'owned.txt');
  fs.writeFileSync(path, 'original');
  return path;
}

it('a vanished-and-restored read is a controlled snapshot conflict, not a hash TypeError', (t) => {
  const path = fixture(t);
  const nativeRead = fs.readFileSync;
  let changed = false;
  try {
    fs.readFileSync = (target, ...args) => {
      if (target !== path || changed) return nativeRead(target, ...args);
      changed = true;
      fs.renameSync(path, path + '.held');
      try { return nativeRead(target, ...args); }
      finally { fs.renameSync(path + '.held', path); }
    };
    syncBuiltinESMExports();
    assert.throws(() => captureRegularFileSnapshot(path),
      /managed destination leaf changed concurrently/);
    assert.equal(changed, true);
    assert.equal(nativeRead(path, 'utf8'), 'original');
  } finally {
    fs.readFileSync = nativeRead;
    syncBuiltinESMExports();
  }
});

it('a failed removal inspection releases its empty reservation and allows immediate retry', (t) => {
  const path = fixture(t);
  const snapshot = captureRegularFileSnapshot(path);
  const nativeRead = fs.readFileSync;
  try {
    fs.readFileSync = (target, ...args) => {
      if (target === path) throw Object.assign(new Error('inspection denied'), { code: 'EACCES' });
      return nativeRead(target, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => removeOwnedRegularFile(path, snapshot.expectedDestination),
      (error) => error.code === 'ERR_ATOMIC_INSPECTION_FAILED');
  } finally {
    fs.readFileSync = nativeRead;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(path, 'utf8'), 'original');
  assert.equal(fs.existsSync(path + '.cah-owned-remove'), false);
  assert.equal(removeOwnedRegularFile(path, snapshot.expectedDestination), true);
});

it('removal refuses a known content mismatch without displacing the canonical file', (t) => {
  const path = fixture(t);
  const stamp = 1_700_000_000;
  fs.utimesSync(path, stamp, stamp);
  const snapshot = captureRegularFileSnapshot(path);
  fs.writeFileSync(path, 'changed!');
  fs.utimesSync(path, stamp, stamp);
  const current = fs.lstatSync(path, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs']) {
    assert.equal(current[key], snapshot.expectedDestination.identity[key]);
  }
  assert.equal(removeOwnedRegularFile(path, snapshot.expectedDestination), false);
  assert.equal(fs.readFileSync(path, 'utf8'), 'changed!');
  assert.equal(fs.existsSync(path + '.cah-owned-remove'), false);
});

it('inspection-error cleanup preserves foreign content added to the reservation', (t) => {
  const path = fixture(t);
  const snapshot = captureRegularFileSnapshot(path);
  const nativeRead = fs.readFileSync;
  const payload = join(path + '.cah-owned-remove', 'foreign');
  try {
    fs.readFileSync = (target, ...args) => {
      if (target === path) {
        if (!fs.existsSync(payload)) fs.writeFileSync(payload, 'keep');
        throw Object.assign(new Error('inspection denied'), { code: 'EACCES' });
      }
      return nativeRead(target, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => removeOwnedRegularFile(path, snapshot.expectedDestination),
      (error) => error.code === 'ERR_ATOMIC_INSPECTION_FAILED');
  } finally {
    fs.readFileSync = nativeRead;
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(path, 'utf8'), 'original');
  assert.equal(fs.readFileSync(payload, 'utf8'), 'keep');
});
