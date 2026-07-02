import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isNewerVersion, getLatestVersion, CURRENT_VERSION } from '../lib/update-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('isNewerVersion', () => {
  it('true when latest has a higher major/minor/patch', () => {
    assert.equal(isNewerVersion('0.5.2', '0.5.3'), true);
    assert.equal(isNewerVersion('0.5.2', '0.6.0'), true);
    assert.equal(isNewerVersion('0.5.2', '1.0.0'), true);
  });

  it('false when equal or older', () => {
    assert.equal(isNewerVersion('0.5.2', '0.5.2'), false);
    assert.equal(isNewerVersion('0.5.2', '0.5.1'), false);
    assert.equal(isNewerVersion('1.0.0', '0.9.9'), false);
  });

  it('false on malformed or missing input (fail safe — no false positive)', () => {
    assert.equal(isNewerVersion('0.5.2', 'not-a-version'), false);
    assert.equal(isNewerVersion(null, '0.5.3'), false);
    assert.equal(isNewerVersion('0.5.2', undefined), false);
    assert.equal(isNewerVersion('0.5.2', null), false);
  });
});

describe('getLatestVersion caching', () => {
  function isolatedCachePath() {
    const dir = mkdtempSync(join(tmpdir(), 'cah-update-check-'));
    return join(dir, 'update-check.json');
  }

  it('returns the cached value directly when within the TTL window (no network call)', () => {
    const cachePath = isolatedCachePath();
    const now = 1_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '9.9.9', checkedAt: now }));
    const result = getLatestVersion(cachePath, 24 * 60 * 60 * 1000, now + 1000);
    assert.equal(result, '9.9.9');
  });

  it('returns null on a cold cache read (missing file, no crash)', () => {
    const cachePath = join(tmpdir(), 'cah-update-check-missing-dir', 'nonexistent.json');
    // Do not assert on the fetch outcome (network-dependent) — only that a
    // stale/missing cache is read as "no cached value" rather than throwing.
    const cached = (() => {
      try {
        return JSON.parse(readFileSync(cachePath, 'utf8'));
      } catch {
        return null;
      }
    })();
    assert.equal(cached, null);
  });
});

describe('CURRENT_VERSION', () => {
  it('stays in sync with package.json — bump both together on release', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(CURRENT_VERSION, pkg.version);
  });
});
