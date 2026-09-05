// Shared update-check helper for the companion bins (cah-status, cah-stamp).
//
// Checks the npm registry for the latest published version of cc-arch-hands,
// cached to a TTL so the network call happens at most once per TTL window —
// not on every statusLine render / Stop event. The network call itself shells
// out to `curl` with a short timeout and is entirely fail-silent: offline,
// missing curl, or a slow registry all just fall back to the last cached
// value (or null on a cold cache).

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';

// Single source of truth for "what version am I". Kept in sync with
// package.json's "version" field by test/update-check.test.js, which fails
// CI if the two ever drift apart.
export const CURRENT_VERSION = '0.8.0';

const REGISTRY_URL = 'https://registry.npmjs.org/cc-arch-hands/latest';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const REFRESH_LOCK_SUFFIX = '.lock';
const REFRESH_LOCK_OWNER = 'owner.json';
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

function readJsonMaybe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, obj) {
  try {
    writeFileAtomic(path, JSON.stringify(obj) + '\n');
  } catch {
    // best-effort cache — fail-silent
  }
}

function sleepSync(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function lockOwnerPath(lockPath) {
  return join(lockPath, REFRESH_LOCK_OWNER);
}

function readLockOwner(lockPath) {
  try {
    const obj = readJsonMaybe(lockOwnerPath(lockPath));
    if (!obj || obj.kind !== 'cc-arch-hands-update-check'
      || !Number.isSafeInteger(obj.pid) || obj.pid <= 0
      || typeof obj.token !== 'string' || obj.token.length === 0
      || typeof obj.startedAt !== 'number' || !Number.isFinite(obj.startedAt)) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but cannot be inspected. Treating it as
    // live is safer than reclaiming another process's active cache lock.
    return e && e.code !== 'ESRCH';
  }
}

function lockIsStale(lockPath, owner, nowMs) {
  if (owner) {
    if (nowMs - owner.startedAt <= LOCK_STALE_MS) return false;
    return !processIsAlive(owner.pid);
  }
  try {
    return nowMs - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    // A lock can briefly exist between mkdir and owner publication. Its
    // directory mtime is the only available age signal in that window.
    return false;
  }
}

function removeStaleLock(lockPath, observedOwner) {
  const quarantine = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    renameSync(lockPath, quarantine);
  } catch (e) {
    if (e && ['ENOENT', 'ENOTDIR', 'EEXIST'].includes(e.code)) return;
    return;
  }

  // Only remove a lock whose owner still matches the observation used to
  // classify it as stale. Unknown contents are preserved in quarantine.
  const movedOwner = readLockOwner(quarantine);
  if (observedOwner) {
    if (!movedOwner || movedOwner.token !== observedOwner.token) return;
  } else if (movedOwner) {
    // A writer may have published an owner between our directory scan and
    // the quarantine rename. It is a live successor even if the original
    // scan saw an empty lock directory.
    return;
  }
  try {
    const entries = readdirSync(quarantine);
    if (entries.length === 1 && entries[0] === REFRESH_LOCK_OWNER) {
      // With no valid owner observation, an owner.json is unknown content;
      // never delete it merely because it failed validation.
      if (!observedOwner) return;
      unlinkSync(lockOwnerPath(quarantine));
    } else if (entries.length !== 0) {
      return;
    }
    rmdirSync(quarantine);
  } catch {
    // A stale lock is only a cache optimization. Leaving the quarantine entry
    // is safe and avoids touching an unexpected file.
  }
}

function releaseRefreshLock(lockPath, token) {
  const owner = readLockOwner(lockPath);
  if (!owner || owner.token !== token) return;
  try {
    unlinkSync(lockOwnerPath(lockPath));
    rmdirSync(lockPath);
  } catch {
    // Best effort. A process crash or a foreign entry must not affect callers.
  }
}

function acquireRefreshLock(cachePath) {
  const lockPath = `${cachePath}${REFRESH_LOCK_SUFFIX}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomBytes(16).toString('hex');
  const owner = {
    kind: 'cc-arch-hands-update-check',
    pid: process.pid,
    token,
    startedAt: Date.now(),
  };

  try { mkdirSync(dirname(cachePath), { recursive: true }); } catch { return null; }

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(lockOwnerPath(lockPath), JSON.stringify(owner) + '\n', {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        return { path: lockPath, token };
      } catch {
        try { rmdirSync(lockPath); } catch { /* best effort */ }
      }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      const currentOwner = readLockOwner(lockPath);
      if (lockIsStale(lockPath, currentOwner, Date.now())) {
        removeStaleLock(lockPath, currentOwner);
        continue;
      }
    }
    sleepSync(10);
  }
  return null;
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
    const beforePublish = readJsonMaybe(cachePath);
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
    writeJsonAtomic(cachePath, { latestVersion, checkedAt: nowMs });
    return latestVersion;
  } finally {
    releaseRefreshLock(lock.path, lock.token);
  }
}
