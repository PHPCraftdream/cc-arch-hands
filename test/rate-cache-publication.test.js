import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { it } from 'node:test';
import { persistRateLimitsCache, rateLimitsContextPath, readRateLimitsCache } from '../lib/transcript-stats.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'cah-rate-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return join(root, 'rate-limits.json');
}

for (const rates of [false, true]) {
  it(`a paused ${rates ? 'global/context' : 'context-only'} writer preserves a newer publication`, (t) => {
    const cache = fixture(t);
    const now = Date.now();
    if (!rates) persistRateLimitsCache(cache, { used: 10 }, null, null, null, 'session', now - 1);
    const nativeOpen = fs.openSync;
    let interleaved = false;
    try {
      fs.openSync = (path, ...args) => {
        const fd = nativeOpen(path, ...args);
        if (typeof path === 'string' && basename(path).startsWith('.cah-tmp-') && !interleaved) {
          interleaved = true;
          try {
            persistRateLimitsCache(cache, rates ? { used: 25 } : null, null, null, 400000, 'session', now + 1);
          } catch (error) { fs.closeSync(fd); throw error; }
        }
        return fd;
      };
      syncBuiltinESMExports();
      persistRateLimitsCache(cache, rates ? { used: 15 } : null, null, null, 300000, 'session', now);
    } finally {
      fs.openSync = nativeOpen;
      syncBuiltinESMExports();
    }
    assert.equal(interleaved, true);
    const result = readRateLimitsCache(cache, now + 1, 'session');
    assert.equal(result.contextWindowSize, 400000);
    assert.equal(result.fiveHour.used, rates ? 25 : 10);
  });
}

it('an older observation does not replace a newer cache already present at entry', (t) => {
  const cache = fixture(t);
  const now = Date.now();
  persistRateLimitsCache(cache, { used: 25 }, null, null, 400000, 'session', now);
  persistRateLimitsCache(cache, { used: 15 }, null, null, 300000, 'session', now - 1);
  const result = readRateLimitsCache(cache, now, 'session');
  assert.equal(result.contextWindowSize, 400000);
  assert.equal(result.fiveHour.used, 25);
});

it('a poisoned future cache does not prevent a current observation from repairing it', (t) => {
  const cache = fixture(t);
  const now = Date.now();
  persistRateLimitsCache(cache, { used: 90 }, null, null, 900000, 'session', now);
  for (const path of [cache, rateLimitsContextPath(cache, 'session')]) {
    const value = JSON.parse(fs.readFileSync(path, 'utf8'));
    fs.writeFileSync(path, JSON.stringify({ ...value, capturedAt: now + 86400000 }));
  }
  persistRateLimitsCache(cache, { used: 25 }, null, null, 400000, 'session', now);
  assert.equal(readRateLimitsCache(cache, now, 'session').contextWindowSize, 400000);
  assert.equal(readRateLimitsCache(cache, now, 'session').fiveHour.used, 25);
});

it('failure of the global cache does not prevent independent session publication', (t) => {
  const cache = fixture(t);
  fs.mkdirSync(cache);
  const now = Date.now();
  persistRateLimitsCache(cache, { used: 25 }, null, null, 400000, 'session', now);
  assert.equal(readRateLimitsCache(cache, now, 'session').contextWindowSize, 400000);
  assert.ok(fs.lstatSync(cache).isDirectory());
});

it('context publication refuses non-regular leaves before reading their contents', (t) => {
  const cache = fixture(t);
  const target = rateLimitsContextPath(cache, 'session');
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.mkdirSync(target);
  const nativeRead = fs.readFileSync;
  let attemptedRead = false;
  try {
    fs.readFileSync = (path, ...args) => {
      if (path === target) attemptedRead = true;
      return nativeRead(path, ...args);
    };
    syncBuiltinESMExports();
    persistRateLimitsCache(cache, null, null, null, 400000, 'session');
  } finally {
    fs.readFileSync = nativeRead;
    syncBuiltinESMExports();
  }
  assert.equal(attemptedRead, false);
  assert.ok(fs.lstatSync(target).isDirectory());
});

it('a newer but malformed cache does not prevent a valid observation from repairing it', (t) => {
  const cache = fixture(t);
  const now = Date.now();
  persistRateLimitsCache(cache, { used: 90 }, null, null, 900000, 'session', now);
  fs.writeFileSync(cache, JSON.stringify({ capturedAt: now + 1, fiveHour: 'invalid' }));
  fs.writeFileSync(rateLimitsContextPath(cache, 'session'),
    JSON.stringify({ capturedAt: now + 1, contextWindowSize: 'invalid' }));
  persistRateLimitsCache(cache, { used: 25 }, null, null, 400000, 'session', now);
  const result = readRateLimitsCache(cache, now, 'session');
  assert.equal(result.contextWindowSize, 400000);
  assert.equal(result.fiveHour.used, 25);
});
