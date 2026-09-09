import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { persistRateLimitsCache, rateLimitsContextPath, readRateLimitsCache } from '../lib/transcript-stats.js';

const now = 1_700_000_000_000;
const session = 'same-session';
const hash = createHash('sha256').update(`string:${session}`).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cah-rate-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'rate-limits.json');
}

it('different cache files in one directory keep independent session contexts', (t) => {
  const cache = fixture(t);
  const other = join(dirname(cache), 'other-cache.json');
  persistRateLimitsCache(cache, null, null, null, 1_000_000, session, now);
  persistRateLimitsCache(other, null, null, null, 200_000, session, now);
  assert.equal(readRateLimitsCache(cache, now, session).contextWindowSize, 1_000_000);
  assert.equal(readRateLimitsCache(other, now, session).contextWindowSize, 200_000);
  assert.notEqual(rateLimitsContextPath(cache, session), rateLimitsContextPath(other, session));
});

it('maintenance of another cache cannot delete this cache session', (t) => {
  const cache = fixture(t);
  const other = join(dirname(cache), 'other-cache.json');
  persistRateLimitsCache(cache, null, null, null, 1_000_000, session, now);
  const sidecar = rateLimitsContextPath(cache, session);
  const stale = (now - 3_601_000) / 1000;
  utimesSync(sidecar, stale, stale);
  persistRateLimitsCache(other, null, null, null, null, session, now);
  assert.equal(existsSync(sidecar), true);
});

it('custom cache migrates only its own unambiguous legacy sidecar', (t) => {
  const cache = fixture(t);
  const other = join(dirname(cache), 'other-cache.json');
  persistRateLimitsCache(cache, null, null, null, 1_000_000, session, now);
  assert.equal(readRateLimitsCache(other, now, session), null);
  const legacy = `${other}.context-${hash}.json`;
  writeFileSync(legacy, JSON.stringify({ contextWindowSize: 200_000, capturedAt: now }));
  assert.equal(readRateLimitsCache(other, now, session)?.contextWindowSize, 200_000);
  assert.equal(existsSync(legacy), false);
  assert.equal(readRateLimitsCache(cache, now, session)?.contextWindowSize, 1_000_000);
});

for (const legacy of [
  { contextWindowSize: 200_000, capturedAt: now + 86_400_000 },
  { contextWindowSize: 'invalid', capturedAt: now + 1000 },
]) {
  it(`invalid legacy context cannot displace a usable current observation (${legacy.contextWindowSize})`, (t) => {
    const cache = fixture(t);
    persistRateLimitsCache(cache, null, null, null, 1_000_000, session, now);
    const target = rateLimitsContextPath(cache, session);
    const before = readFileSync(target, 'utf8');
    const source = `${cache}.context-${hash}.json`;
    const legacyBytes = JSON.stringify(legacy);
    writeFileSync(source, legacyBytes);
    assert.equal(readRateLimitsCache(cache, now, session)?.contextWindowSize, 1_000_000);
    assert.equal(readFileSync(target, 'utf8'), before);
    assert.equal(readFileSync(source, 'utf8'), legacyBytes);
  });
}

it('a usable legacy observation replaces an invalid future current cache', (t) => {
  const cache = fixture(t);
  const target = rateLimitsContextPath(cache, session);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ contextWindowSize: 1_000_000, capturedAt: now + 86_400_000 }));
  writeFileSync(`${cache}.context-${hash}.json`, JSON.stringify({ contextWindowSize: 200_000, capturedAt: now }));
  assert.equal(readRateLimitsCache(cache, now, session)?.contextWindowSize, 200_000);
});
