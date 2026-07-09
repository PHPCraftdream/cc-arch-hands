// Shared update-check helper for the companion bins (cah-status, cah-stamp).
//
// Checks the npm registry for the latest published version of cc-arch-hands,
// cached to a TTL so the network call happens at most once per TTL window —
// not on every statusLine render / Stop event. The network call itself shells
// out to `curl` with a short timeout and is entirely fail-silent: offline,
// missing curl, or a slow registry all just fall back to the last cached
// value (or null on a cold cache).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Single source of truth for "what version am I". Kept in sync with
// package.json's "version" field by test/update-check.test.js, which fails
// CI if the two ever drift apart.
export const CURRENT_VERSION = '0.6.1';

const REGISTRY_URL = 'https://registry.npmjs.org/cc-arch-hands/latest';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

function readJsonMaybe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, obj) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj) + '\n');
    renameSync(tmp, path);
  } catch {
    // best-effort cache — fail-silent
  }
}

function fetchLatestVersionSync(timeoutMs) {
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
  if (cached && typeof cached.checkedAt === 'number' && nowMs - cached.checkedAt < ttlMs) {
    return typeof cached.latestVersion === 'string' ? cached.latestVersion : null;
  }
  const fetched = fetchLatestVersionSync(FETCH_TIMEOUT_MS);
  const latestVersion = fetched || (cached && cached.latestVersion) || null;
  writeJsonAtomic(cachePath, { latestVersion, checkedAt: nowMs });
  return latestVersion;
}
