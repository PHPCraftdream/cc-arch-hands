import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { redundantRewrite } from '../lib/rate-limits-cache.js';
import {
  persistRateLimitsCache, rateLimitsContextPath, rateLimitsQuotaPath,
} from '../lib/transcript-stats.js';

// Each rewrite is a temp window that a cancelled statusLine run can strand, so
// a render that observes nothing new must not touch the cache files.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-rate-rewrite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'rate-limits.json');
}

const slot = (used) => ({ used, resetsAt: '2027-01-01T00:00:00.000Z' });

describe('rate cache rewrite throttle', () => {
  it('leaves every file untouched when a render repeats the same observation', (t) => {
    const cache = fixture(t);
    const now = Date.now();
    const files = [cache, rateLimitsQuotaPath(cache, 'session'), rateLimitsContextPath(cache, 'session')];
    persistRateLimitsCache(cache, slot(25), slot(40), 'high', 1_000_000, 'session', now);
    const first = files.map((path) => readFileSync(path, 'utf8'));
    persistRateLimitsCache(cache, slot(25), slot(40), 'high', 1_000_000, 'session', now + 30_000);
    assert.deepEqual(files.map((path) => readFileSync(path, 'utf8')), first);
  });

  it('writes a changed value at once and refreshes an unchanged one after a minute', (t) => {
    const cache = fixture(t);
    const context = rateLimitsContextPath(cache, 'session');
    const now = Date.now();
    persistRateLimitsCache(cache, slot(25), null, 'high', 1_000_000, 'session', now);
    persistRateLimitsCache(cache, slot(26), null, 'high', 1_000_000, 'session', now + 31_000);
    const global = JSON.parse(readFileSync(cache, 'utf8'));
    assert.equal(global.fiveHour.used, 26);
    assert.equal(global.capturedAt, now + 31_000);
    assert.equal(JSON.parse(readFileSync(context, 'utf8')).capturedAt, now, 'unchanged context kept');

    persistRateLimitsCache(cache, slot(26), null, 'high', 1_000_000, 'session', now + 92_000);
    assert.equal(JSON.parse(readFileSync(cache, 'utf8')).capturedAt, now + 92_000);
    assert.equal(JSON.parse(readFileSync(context, 'utf8')).capturedAt, now + 92_000);
  });

  it('rewrites when another field such as effort or the session owner changes', (t) => {
    const cache = fixture(t);
    const now = Date.now();
    persistRateLimitsCache(cache, slot(25), null, 'high', null, 'one', now);
    persistRateLimitsCache(cache, slot(25), null, 'max', null, 'one', now + 1000);
    assert.equal(JSON.parse(readFileSync(cache, 'utf8')).effort, 'max');
    persistRateLimitsCache(cache, slot(25), null, 'max', null, 'two', now + 2000);
    assert.equal(JSON.parse(readFileSync(cache, 'utf8')).capturedAt, now + 2000);
  });
});

describe('redundantRewrite', () => {
  const now = 1_800_000_000_000;
  const base = { version: 4, fiveHour: slot(25), fiveHourCapturedAt: now, sevenDay: null,
    sevenDayCapturedAt: null, capturedAt: now };

  it('accepts only forward time moves inside the window', () => {
    assert.equal(redundantRewrite(base, { ...base, fiveHourCapturedAt: now + 59_999, capturedAt: now + 59_999 }), true);
    assert.equal(redundantRewrite(base, { ...base, capturedAt: now + 60_000 }), false);
    assert.equal(redundantRewrite(base, { ...base, capturedAt: now - 1 }), false);
  });

  it('refreshes a slot whose own observation time is old even if the record is recent', () => {
    const retained = { ...base, fiveHourCapturedAt: now - 50 * 60_000 };
    assert.equal(redundantRewrite(retained, { ...base, capturedAt: now + 1000, fiveHourCapturedAt: now + 1000 }), false);
  });

  it('never treats a value change, a null/number mismatch or a missing record as redundant', () => {
    assert.equal(redundantRewrite(base, { ...base, fiveHour: slot(26) }), false);
    assert.equal(redundantRewrite(base, { ...base, sevenDayCapturedAt: now }), false);
    assert.equal(redundantRewrite(null, base), false);
    assert.equal(redundantRewrite([], base), false);
  });
});
