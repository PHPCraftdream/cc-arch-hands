// Shared update-check helper for the companion bins (cah-status, cah-stamp).
//
// Checks the npm registry for the latest published version of cc-arch-hands,
// cached to a TTL so the network call happens at most once per TTL window —
// not on every statusLine render / Stop event. The network call itself shells
// out to `curl` with a short timeout and is entirely fail-silent: offline,
// missing curl, or a slow registry all just fall back to the last cached
// value (or null on a cold cache).

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { captureRegularFileSnapshot, writeFileAtomic } from './fsutil.js';
import { acquireLease, releaseLease } from './lease-lock.js';

// Single source of truth for "what version am I". Kept in sync with
// package.json's "version" field by test/update-check.test.js, which fails
// CI if the two ever drift apart.
export const CURRENT_VERSION = '0.8.0';

const REGISTRY_URL = 'https://registry.npmjs.org/cc-arch-hands/latest';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const REFRESH_LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 30_000;

function readJsonMaybe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, obj, options = {}) {
  try {
    writeFileAtomic(path, JSON.stringify(obj) + '\n', options);
    return true;
  } catch {
    // best-effort cache — fail-silent
    return false;
  }
}

function acquireRefreshLock(cachePath) {
  return acquireLease(`${cachePath}${REFRESH_LOCK_SUFFIX}`, {
    kind: 'cc-arch-hands-update-check',
    staleAfterMs: LOCK_STALE_MS,
    fenceSuffix: '.stale-',
    interlockPhase: 'reclaim',
  });
}

function releaseRefreshLock(lock) {
  releaseLease(lock);
}

function cacheIsFresh(cache, nowMs, ttlMs) {
  return cache && typeof cache.checkedAt === 'number'
    && nowMs - cache.checkedAt < ttlMs;
}

function cacheRecordChanged(before, after) {
  if (!before || !after) return Boolean(before || after);
  return before.checkedAt !== after.checkedAt
    || before.latestVersion !== after.latestVersion;
}

function fetchFromTestHook(timeoutMs) {
  if (process.env.CAH_TEST_ONLY !== '1' || !process.env.CAH_TEST_ONLY_UPDATE_FETCH) return undefined;
  const spec = readJsonMaybe(process.env.CAH_TEST_ONLY_UPDATE_FETCH);
  if (!spec) return null;
  const ready = typeof spec.readyPath === 'string' ? spec.readyPath : null;
  const go = typeof spec.goPath === 'string' ? spec.goPath : null;
  if (ready) {
    try { writeFileSync(ready, 'ready\n', { flag: 'wx' }); } catch { /* best effort */ }
  }
  if (go) {
    const deadline = Date.now() + Math.max(1000, timeoutMs * 10);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      try {
        readFileSync(go);
        break;
      } catch (e) {
        if (!e || e.code !== 'ENOENT') return null;
        if (Date.now() >= deadline) return null;
        Atomics.wait(signal, 0, 0, 10);
      }
    }
  }
  return typeof spec.result === 'string' ? spec.result : null;
}

function fetchLatestVersionSync(timeoutMs) {
  const testResult = fetchFromTestHook(timeoutMs);
  if (testResult !== undefined) return testResult;
  try {
    const out = execFileSync(
      'curl',
      ['-s', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), REGISTRY_URL],
      { encoding: 'utf8', timeout: timeoutMs + 500 },
    );
    const obj = JSON.parse(out);
    return typeof obj.version === 'string' ? obj.version : null;
  } catch {
    return null;
  }
}

/**
 * True if `latest` is a strictly newer dotted-numeric version than
 * `current`. Malformed input never reports a false "update available".
 */
export function isNewerVersion(current, latest) {
  if (typeof current !== 'string' || typeof latest !== 'string') return false;
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/**
 * Returns the latest published version, using a TTL-cached read so the
 * npm registry is hit at most once per `ttlMs`. `cachePath` is shared
 * between cah-status and cah-stamp — whichever runs first populates it.
 */
export function getLatestVersion(cachePath, ttlMs = DEFAULT_TTL_MS, nowMs = Date.now()) {
  const cached = readJsonMaybe(cachePath);
  if (cacheIsFresh(cached, nowMs, ttlMs)) {
    return typeof cached.latestVersion === 'string' ? cached.latestVersion : null;
  }

  const lock = acquireRefreshLock(cachePath);
  if (!lock) {
    const afterWait = readJsonMaybe(cachePath);
    return afterWait && typeof afterWait.latestVersion === 'string'
      ? afterWait.latestVersion
      : cached && typeof cached.latestVersion === 'string'
        ? cached.latestVersion
        : null;
  }

  try {
    // Another caller may have completed the refresh while this caller waited
    // for the directory lock. This second read is what makes one refresh per
    // TTL true across processes, not merely within one module instance.
    const afterLock = readJsonMaybe(cachePath);
    if (cacheIsFresh(afterLock, nowMs, ttlMs)) {
      return typeof afterLock.latestVersion === 'string' ? afterLock.latestVersion : null;
    }

    const fetched = fetchLatestVersionSync(FETCH_TIMEOUT_MS);
    // The cache is a managed, small JSON leaf. Capture its bytes and exact
    // BigInt identity together for the final publication CAS; an in-place
    // same-size edit with restored timestamps must still be rejected.
    const beforePublishSnapshot = captureRegularFileSnapshot(cachePath);
    const beforePublish = beforePublishSnapshot.present
      ? (() => {
        try { return JSON.parse(beforePublishSnapshot.content.toString('utf8')); } catch { return null; }
      })()
      : null;
    const changedToFresher = cacheRecordChanged(cached, beforePublish)
      && beforePublish
      && typeof beforePublish.checkedAt === 'number'
      && (beforePublish.checkedAt > (cached && typeof cached.checkedAt === 'number'
        ? cached.checkedAt : -Infinity) || cacheIsFresh(beforePublish, nowMs, ttlMs));
    if (changedToFresher) {
      return typeof beforePublish.latestVersion === 'string' ? beforePublish.latestVersion : null;
    }

    const latestVersion = fetched || (beforePublish && beforePublish.latestVersion)
      || (cached && cached.latestVersion) || null;
    // A failed fetch still records the check time, preserving the at-most-once
    // TTL contract, while the re-read above prevents it from erasing a newer
    // successful publisher.
    const published = writeJsonAtomic(
      cachePath,
      { latestVersion, checkedAt: nowMs },
      { expectedDestination: beforePublishSnapshot.expectedDestination },
    );
    if (!published) {
      const concurrentWinner = readJsonMaybe(cachePath);
      if (concurrentWinner && typeof concurrentWinner.latestVersion === 'string') {
        return concurrentWinner.latestVersion;
      }
    }
    return latestVersion;
  } finally {
    releaseRefreshLock(lock);
  }
}
