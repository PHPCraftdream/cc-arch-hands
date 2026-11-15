import { lstatSync, opendirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
// Marker/transaction namespaces: a direct temp there is reclaimed only after a
// week, far past any writer's life; their transaction directories stay alone.
export const MARKER_TEMP_SUBDIRS = Object.freeze(['stamp-state', 'update-markers', 'hint-markers']);
export const MARKER_TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Recovery directories a removal or publication left beside a disposable cache
// leaf (`<leaf>.json.cah-owned-remove`, `<leaf>.json.cah-owned-publish`, and its
// `.quarantine-<uuid>` form). They are kept for review; in the sidecar caches
// nothing reads them, so after a week they go.
const RECOVERY_SUFFIX = /\.json\.cah-owned-(?:remove|publish)(?:\.quarantine-[0-9a-f-]{36})?$/;
// Only leaves the cache itself writes: never a file such as probe-backup.json, which is the user's.
const ROOT_LEAF = /^(?:rate-limits|update-check|proxy-model-\d+)$/;
const SIDECAR_LEAF = /^(?:[a-f0-9]{64}|context-\d+)$/;
export const RECOVERY_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

// A directory and everything in it is older than the age floor (no live writer).
function agedTree(path, now, maxAgeMs) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || !isOlderThan(stat, now, maxAgeMs)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) { if (!agedTree(child, now, maxAgeMs)) return false; continue; }
    if (!isOlderThan(lstatSync(child, { bigint: true }), now, maxAgeMs)) return false;
  }
  return true;
}

// Removes aged recovery directories (direct entries of `root`, exact name form).
export function sweepStaleRecoveryDirs(root, options = {}) {
  const leaf = options.leaf ?? SIDECAR_LEAF;
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs >= 0
    ? options.maxAgeMs : RECOVERY_DIR_MAX_AGE_MS;
  const limit = boundedLimit(options.limit, STALE_TEMP_SWEEP_LIMIT);
  const report = { swept: [], failures: [], stuck: [], incomplete: false, truncated: false };
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RECOVERY_SUFFIX.test(entry.name)
        && leaf.test(entry.name.replace(RECOVERY_SUFFIX, ''))).map((entry) => entry.name);
  } catch (error) {
    if (error.code !== 'ENOENT') report.failures.push({ path: resolve(root), code: error.code || 'UNKNOWN' });
    return report;
  }
  if (names.length > limit) { report.truncated = true; names = names.slice(0, limit); }
  const now = options.now ?? Date.now();
  for (const name of names) {
    const path = join(root, name);
    assertOwnership(options);
    try {
      if (!agedTree(path, now, maxAgeMs)) continue;
      (options.removeTree ?? rmSync)(path, { recursive: true });
      report.swept.push(path);
    } catch (error) {
      if (isOwnershipLoss(error)) throw error;
      // Kept for review and tried again tomorrow; never a reason to rescan on every render.
      if (error.code !== 'ENOENT') report.stuck.push(path);
    }
  }
  return report;
}

function mergeReport(total, report) {
  total.swept.push(...report.swept);
  total.stuck.push(...(report.stuck ?? []));
  total.failures.push(...report.failures);
  total.incomplete ||= report.incomplete;
  total.truncated ||= report.truncated;
}

// Sweeps the cache root and every sidecar namespace (temps and recovery
// directories), and the marker namespaces' week-old temps. Reports are merged.
export function sweepStaleCacheTemps(cacheDir, options = {}) {
  const total = { swept: [], failures: [], stuck: [], incomplete: false, truncated: false };
  for (const root of [cacheDir, ...STALE_TEMP_SUBDIRS.map((name) => join(cacheDir, name))]) {
    // Recovery dirs first: an aged publication fence with no readable proof would
    // otherwise make the temp sweep give up (and skip the daily stamp) for good.
    mergeReport(total, sweepStaleRecoveryDirs(root, { ...options, leaf: root === cacheDir ? ROOT_LEAF : SIDECAR_LEAF }));
    mergeReport(total, sweepStaleAtomicTemps(root, options));
  }
  for (const name of MARKER_TEMP_SUBDIRS) {
    mergeReport(total, sweepStaleAtomicTemps(join(cacheDir, name), {
      ...options, maxAgeMs: Math.max(MARKER_TEMP_MAX_AGE_MS, options.maxAgeMs ?? 0),
    }));
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
