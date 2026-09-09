import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { getLatestVersion } from '../lib/update-check.js';
import { readRateLimitsCache, rateLimitsContextPath } from '../lib/transcript-stats.js';

const now = 1_700_000_000_000;

function cache(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-cache-time-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'cache.json');
}

for (const capturedAt of [String(now + 86_400_000), '1e400']) {
  it(`update cache refreshes an invalid future timestamp ${capturedAt}`, (t) => {
    const path = cache(t);
    writeFileSync(path, `{"latestVersion":"0.8.0","checkedAt":${capturedAt}}`);
    let fetches = 0;
    assert.equal(getLatestVersion(path, 10_000, now, {
      fetchLatestVersion: () => { fetches++; return '0.8.1'; },
    }), '0.8.1');
    assert.equal(fetches, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).checkedAt, now);
  });

  it(`rate cache rejects future base and context timestamp ${capturedAt}`, (t) => {
    const path = cache(t);
    const sidecar = rateLimitsContextPath(path, 'session');
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(path, `{"fiveHour":{"used":77},"capturedAt":${capturedAt}}`);
    writeFileSync(sidecar, `{"contextWindowSize":1000000,"capturedAt":${capturedAt}}`);
    assert.equal(readRateLimitsCache(path, now, 'session'), null);
  });
}

it('fresh cache observations tolerate bounded scheduling skew', (t) => {
  const path = cache(t);
  writeFileSync(path, JSON.stringify({ latestVersion: '0.8.1', checkedAt: now + 1000,
    capturedAt: now + 1000, fiveHour: { used: 11 } }));
  assert.equal(getLatestVersion(path, 10_000, now, {
    fetchLatestVersion: () => assert.fail('fresh cache must not fetch'),
  }), '0.8.1');
  assert.equal(readRateLimitsCache(path, now).fiveHour.used, 11);
});

it('update refresh does not accept a concurrent future-dated cache as newer', (t) => {
  const path = cache(t);
  assert.equal(getLatestVersion(path, 10_000, now, {
    fetchLatestVersion: () => {
      writeFileSync(path, JSON.stringify({ latestVersion: '0.8.0', checkedAt: now + 86_400_000 }));
      return '0.8.1';
    },
  }), '0.8.1');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).checkedAt, now);
});
