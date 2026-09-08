// Shared update-check helper for the companion bins (cah-status, cah-stamp).
//
// Checks the npm registry for the latest published version of cc-arch-hands,
// cached to a TTL so the network call happens at most once per TTL window —
// not on every statusLine render / Stop event. The network call itself shells
// out to `curl` with a short timeout and is entirely fail-silent: offline,
// missing curl, or a slow registry all just fall back to the last cached
// value (or null on a cold cache).

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

function acquireRefreshLock(cachePath, testInterlock = null) {
  return acquireLease(`${cachePath}${REFRESH_LOCK_SUFFIX}`, {
    kind: 'cc-arch-hands-update-check',
    staleAfterMs: LOCK_STALE_MS,
    fenceSuffix: '.stale-',
    interlockPhase: 'reclaim',
    testInterlock,
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

function fetchLatestVersionSync(timeoutMs, fetchOverride = null) {
  if (typeof fetchOverride === 'function') {
    try {
      const result = fetchOverride(timeoutMs);
      return typeof result === 'string' ? result : null;
    } catch {
      return null;
    }
  }
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

// SemVer 2.0.0 precedence (semver.org #spec-item-11): major, minor, and
// patch compare numerically; a version with a prerelease has LOWER precedence
// than the same normal version without one; prerelease identifiers compare
// field by field, numerically when both are numeric (rc.2 < rc.10) and
// lexically otherwise, with numeric below alphanumeric and a longer equal
// prefix ranking higher; build metadata (+...) is ignored entirely.
function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = Number(left);
    const b = Number(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * True if `latest` has strictly higher SemVer precedence than `current`.
 * Prerelease versions (published under the `next` dist-tag) therefore order
 * below their own stable release. Malformed input never reports a false
 * "update available".
 */
export function isNewerVersion(current, latest) {
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b.core[i] !== a.core[i]) return b.core[i] > a.core[i];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // The candidate is newer only when it is stable and the current one is a
    // prerelease of the same normal version.
    return a.prerelease.length > 0 && b.prerelease.length === 0;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined) return true;
    if (b.prerelease[i] === undefined) return false;
    const order = comparePrereleaseIdentifiers(b.prerelease[i], a.prerelease[i]);
    if (order !== 0) return order > 0;
  }
  return false;
}

/**
 * Returns the latest published version, using a TTL-cached read so the
 * npm registry is hit at most once per `ttlMs`. `cachePath` is shared
 * between cah-status and cah-stamp — whichever runs first populates it.
 */
export function getLatestVersion(cachePath, ttlMs = DEFAULT_TTL_MS, nowMs = Date.now(), options = {}) {
  const cached = readJsonMaybe(cachePath);
  if (cacheIsFresh(cached, nowMs, ttlMs)) {
    return typeof cached.latestVersion === 'string' ? cached.latestVersion : null;
  }

  const lock = acquireRefreshLock(cachePath, options.testInterlock);
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

    const fetched = fetchLatestVersionSync(
      FETCH_TIMEOUT_MS,
      typeof options?.fetchLatestVersion === 'function' ? options.fetchLatestVersion : null,
    );
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
      { expectedDestination: beforePublishSnapshot.expectedDestination,
        testInterlock: options.testInterlock },
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
