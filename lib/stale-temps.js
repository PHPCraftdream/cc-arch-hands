import { lstatSync, opendirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isOlderThan, sameStatInteger } from './fs-atomic-identity.js';
import {
  AtomicOwnershipLostError, PUBLICATION_FENCE_SUFFIX, readPublicationProof,
} from './fs-atomic-publication.js';

const STALE_TEMP_NAME = /^\.cah-tmp-\d+-[0-9a-f]{32}$/;
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_SWEEP_LIMIT = 5000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SWEEP_STAMP = 'stale-temp-sweep.stamp';
// A freshly written stamp can carry an mtime a little ahead of Date.now()
// (coarse or skewed filesystem clocks); only a stamp further ahead is bogus.
const STAMP_SKEW_MS = 5 * 60 * 1000;

// Cache namespaces that only hold sidecar JSON written through writeFileAtomic.
// Marker/transaction namespaces (stamp-state, update-markers, hint-markers) keep
// proof-only recovery and are deliberately absent.
export const STALE_TEMP_SUBDIRS = Object.freeze([
  'rate-context', 'rate-quota', 'context-measured', 'context-trace',
]);

function sameStat(left, right) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs'].every((key) => sameStatInteger(left[key], right[key]));
}

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, fallback) : fallback;
}

function assertOwnership(options) {
  if (options.assertOwnership?.() === false) throw new AtomicOwnershipLostError();
}

function isOwnershipLoss(error) {
  return Boolean(error?.leaseLost || error?.code === 'ERR_ATOMIC_OWNERSHIP_LOST'
    || error instanceof AtomicOwnershipLostError);
}

// Remove writeFileAtomic temps stranded by a writer killed before rename.
// Direct entries of `root` only; a temp qualifies only when its name is the exact
// pid+random form, it is a regular file older than the age floor, and no
// publication proof in `root` still names it. The caller must own `root`.
export function sweepStaleAtomicTemps(root, options = {}) {
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs >= 0
    ? options.maxAgeMs : STALE_TEMP_MAX_AGE_MS;
  const limit = boundedLimit(options.limit, STALE_TEMP_SWEEP_LIMIT);
  const report = { swept: [], failures: [], incomplete: false, truncated: false };
  let handle;
  try { handle = opendirSync(root); } catch (error) {
    if (error.code !== 'ENOENT') report.failures.push({ path: resolve(root), code: error.code || 'UNKNOWN' });
    return report;
  }
  const candidates = [];
  const referenced = new Set();
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (STALE_TEMP_NAME.test(entry.name)) {
        if (candidates.length < limit) candidates.push(entry.name); else report.truncated = true;
      } else if (entry.name.endsWith(PUBLICATION_FENCE_SUFFIX)) {
        const proof = readPublicationProof(join(root, entry.name));
        if (proof?.tempPath) referenced.add(resolve(proof.tempPath));
        else report.incomplete = true;
      }
    }
  } catch (error) {
    report.failures.push({ path: resolve(root), code: error.code || 'UNKNOWN' });
    report.incomplete = true;
    return report;
  } finally {
    try { handle.closeSync(); } catch { /* best effort */ }
  }
  // An unreadable fence may name any temp: sweep nothing rather than guess.
  if (report.incomplete) return report;
  const now = Date.now();
  for (const name of candidates) {
    const path = join(root, name);
    if (referenced.has(resolve(path))) continue;
    assertOwnership(options);
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || !isOlderThan(stat, now, maxAgeMs)) continue;
      if (!sameStat(stat, lstatSync(path, { bigint: true }))) continue;
      unlinkSync(path);
      report.swept.push(path);
    } catch (error) {
      if (isOwnershipLoss(error)) throw error;
      if (error.code !== 'ENOENT') report.failures.push({ path, code: error.code || 'UNKNOWN' });
    }
  }
  return report;
}

// Sweeps the cache root and every sidecar namespace. Reports are merged per root.
export function sweepStaleCacheTemps(cacheDir, options = {}) {
  const total = { swept: [], failures: [], incomplete: false, truncated: false };
  for (const root of [cacheDir, ...STALE_TEMP_SUBDIRS.map((name) => join(cacheDir, name))]) {
    const report = sweepStaleAtomicTemps(root, options);
    total.swept.push(...report.swept);
    total.failures.push(...report.failures);
    total.incomplete ||= report.incomplete;
    total.truncated ||= report.truncated;
  }
  return total;
}

// Runtime hook for the status bin: sweeps at most once per interval. The stamp is
// a fixed-name file touched in place (never an atomic temp, so it cannot leak one),
// and only after a complete sweep so an interrupted run retries on the next render.
// Concurrent runs are harmless: the sweep is idempotent and aged-temp only.
// Returns the report, or null when not due. Never throws.
export function sweepStaleTempsDaily(cacheDir, options = {}) {
  try {
    const now = options.now ?? Date.now();
    const interval = options.intervalMs ?? SWEEP_INTERVAL_MS;
    const stamp = join(cacheDir, SWEEP_STAMP);
    try {
      const age = now - statSync(stamp).mtimeMs;
      if (age >= -STAMP_SKEW_MS && age < interval) return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
    const report = sweepStaleCacheTemps(cacheDir, options);
    if (!report.incomplete && report.failures.length === 0) {
      try { writeFileSync(stamp, ''); } catch { /* best effort */ }
    }
    return report;
  } catch {
    return null;
  }
}
