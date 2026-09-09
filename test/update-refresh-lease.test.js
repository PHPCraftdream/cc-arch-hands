import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { getLatestVersion } from '../lib/update-check.js';
import { acquireLease, leaseOwned, releaseLease, LEASE_MAX_MS } from '../lib/lease-lock.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-update-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'update.json');
}

function expire(cache) {
  const path = join(`${cache}.lock`, 'owner.json');
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  owner.timestamp = Date.now() - LEASE_MAX_MS - 1000;
  writeFileSync(path, JSON.stringify(owner));
}

it('a suspended refresh cannot overwrite its successor after lease takeover', (t) => {
  const cache = fixture(t);
  const now = Date.now();
  const result = getLatestVersion(cache, 10_000, now, { fetchLatestVersion: () => {
    expire(cache);
    assert.equal(getLatestVersion(cache, 10_000, now + 6000, {
      fetchLatestVersion: () => '0.8.2',
    }), '0.8.2');
    return '0.8.1';
  } });
  assert.equal(result, '0.8.2');
  assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')), {
    latestVersion: '0.8.2', checkedAt: now + 6000,
  });
});

it('refresh publication rechecks ownership at its final filesystem boundary', (t) => {
  const cache = fixture(t);
  let successor;
  try {
    getLatestVersion(cache, 10_000, Date.now(), {
      fetchLatestVersion: () => '0.8.1',
      testInterlock: (phase) => {
        if (phase !== 'write-before-final-operation' || successor) return;
        expire(cache);
        successor = acquireLease(`${cache}.lock`, { fenceSuffix: '.stale-' });
        assert.ok(successor);
      },
    });
    assert.ok(successor && leaseOwned(successor));
    assert.equal(existsSync(cache), false);
  } finally {
    if (successor) releaseLease(successor);
  }
});
