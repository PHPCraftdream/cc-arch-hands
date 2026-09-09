import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { persistRateLimitsCache, readRateLimitsCache } from '../lib/transcript-stats.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-rate-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'rate-limits.json');
}

for (const record of [{}, { fiveHour: {} }, { fiveHour: { resetsAt: {} } }]) {
  it(`a newer malformed rate record cannot block repair: ${JSON.stringify(record)}`, (t) => {
    const path = fixture(t);
    const now = Date.now();
    writeFileSync(path, JSON.stringify({ ...record, capturedAt: now + 1000 }));
    persistRateLimitsCache(path, { used: 25, resetsAt: null }, null, null, null, 'session', now);
    assert.equal(readRateLimitsCache(path, now, 'session').fiveHour?.used, 25);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).capturedAt, now);
  });
}

for (const slot of [null, { used: 15 }, { resetsAt: '2026-09-10T00:00:00Z' }]) {
  it(`a valid newer nullable or partial rate slot remains authoritative: ${JSON.stringify(slot)}`, (t) => {
    const path = fixture(t);
    const now = Date.now();
    const content = JSON.stringify({ fiveHour: slot, capturedAt: now + 1000 });
    writeFileSync(path, content);
    persistRateLimitsCache(path, { used: 25 }, null, null, null, 'session', now);
    assert.equal(readFileSync(path, 'utf8'), content);
  });
}
