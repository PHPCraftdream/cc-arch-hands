import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { acquireLease, leaseOwned, releaseLease, LEASE_MAX_MS } from '../lib/lease-lock.js';

it('acquire never reclaims a second successor during its final claim attempt', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'cah-lease-attempts-'));
  const path = join(root, 'claim');
  const originalMkdir = fs.mkdirSync;
  const originalRmdir = fs.rmdirSync;
  const owner = { pid: process.pid, token: 'old', generation: 'old',
    timestamp: Date.now() - LEASE_MAX_MS - 1000 };
  fs.mkdirSync(path);
  fs.writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
  let attempts = 0;
  try {
    fs.mkdirSync = (target, options) => {
      if (target === path) attempts++;
      return originalMkdir(target, options);
    };
    fs.rmdirSync = (target, options) => {
      const result = originalRmdir(target, options);
      if (target.startsWith(`${path}.taken-`)) {
        originalMkdir(path);
        fs.writeFileSync(join(path, 'owner.json'), JSON.stringify({ ...owner, token: 'successor' }));
      }
      return result;
    };
    syncBuiltinESMExports();
    assert.equal(acquireLease(path), null);
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(fs.readFileSync(join(path, 'owner.json'), 'utf8')).token, 'successor');
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.rmdirSync = originalRmdir;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['parent creation', 'expired claim removal']) {
  it(`acquire attempts the free claim after a slow ${stage}`, () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'cah-lease-budget-'));
    const path = join(root, 'claim');
    const originalNow = Date.now;
    const originalMkdir = fs.mkdirSync;
    const originalRmdir = fs.rmdirSync;
    let offset = 0;
    let lease = null;
    try {
      if (stage === 'expired claim removal') {
        fs.mkdirSync(path);
        fs.writeFileSync(join(path, 'owner.json'), JSON.stringify({
          pid: process.pid, token: 'old-token', generation: 'old-generation',
          timestamp: originalNow() - LEASE_MAX_MS - 1000,
        }));
      }
      Date.now = () => originalNow() + offset;
      fs.mkdirSync = (target, options) => {
        const result = originalMkdir(target, options);
        if (stage === 'parent creation' && target === root) offset = 1000;
        return result;
      };
      fs.rmdirSync = (target, options) => {
        const result = originalRmdir(target, options);
        if (stage === 'expired claim removal' && target.startsWith(`${path}.taken-`)) offset = 1000;
        return result;
      };
      syncBuiltinESMExports();
      lease = acquireLease(path);
      assert.equal(offset, 1000, 'the filesystem boundary must advance the test clock');
      assert.ok(lease, 'a successful preparation must still attempt the available claim');
      assert.ok(leaseOwned(lease));
    } finally {
      Date.now = originalNow;
      fs.mkdirSync = originalMkdir;
      fs.rmdirSync = originalRmdir;
      syncBuiltinESMExports();
      if (lease) releaseLease(lease);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
