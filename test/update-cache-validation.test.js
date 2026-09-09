import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { getLatestVersion } from '../lib/update-check.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-update-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'update.json');
}

for (const latestVersion of [42, {}, 'not-a-version']) {
  it(`repairs a fresh cache with invalid latestVersion ${JSON.stringify(latestVersion)}`, (t) => {
    const path = fixture(t);
    const now = Date.now();
    writeFileSync(path, JSON.stringify({ latestVersion, checkedAt: now }));
    let fetched = false;
    assert.equal(getLatestVersion(path, 10_000, now, { fetchLatestVersion: () => {
      fetched = true;
      return '0.8.1';
    } }), '0.8.1');
    assert.equal(fetched, true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).latestVersion, '0.8.1');
  });
}

it('an invalid fetch cannot replace the last valid cached version', (t) => {
  const path = fixture(t);
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ latestVersion: '0.8.1', checkedAt: 0 }));
  assert.equal(getLatestVersion(path, 10_000, now, {
    fetchLatestVersion: () => 'invalid',
  }), '0.8.1');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).latestVersion, '0.8.1');
});

it('failed refresh returns null instead of an invalid cached object', (t) => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify({ latestVersion: { version: '0.8.1' }, checkedAt: 0 }));
  assert.equal(getLatestVersion(path, 10_000, Date.now(), { fetchLatestVersion: () => null }), null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).latestVersion, null);
});

it('a valid negative cache still suppresses repeat fetches during TTL', (t) => {
  const path = fixture(t);
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ latestVersion: null, checkedAt: now }));
  assert.equal(getLatestVersion(path, 10_000, now, {
    fetchLatestVersion: () => assert.fail('negative cache must remain fresh'),
  }), null);
});

it('a concurrent malformed record does not supersede a valid fetch result', (t) => {
  const path = fixture(t);
  const now = Date.now();
  assert.equal(getLatestVersion(path, 10_000, now, { fetchLatestVersion: () => {
    writeFileSync(path, JSON.stringify({ latestVersion: {}, checkedAt: now }));
    return '0.8.1';
  } }), '0.8.1');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).latestVersion, '0.8.1');
});

for (const cached of [false, true]) {
  it(`normalizes a ${cached ? 'cached' : 'fetched'} version before display`, (t) => {
    const path = fixture(t);
    const now = Date.now();
    if (cached) writeFileSync(path, JSON.stringify({ latestVersion: ' v0.8.1\n ', checkedAt: now }));
    assert.equal(getLatestVersion(path, 10_000, now, { fetchLatestVersion: () => {
      assert.equal(cached, false);
      return ' v0.8.1\n ';
    } }), '0.8.1');
  });
}
