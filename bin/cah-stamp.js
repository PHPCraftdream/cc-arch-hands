#!/usr/bin/env node
// cah-stamp — Claude Code Stop hook installed by /clock.
//
// After each assistant turn, reads the hook JSON payload from stdin,
// inspects the session transcript for the latest usage.input_tokens and model,
// then emits a systemMessage with the current time/model/context status so
// the chat scrollback contains a timestamped audit trail.
//
// It is deliberately fail-silent: any error, missing input, or filesystem
// hiccup results in `exit 0` with no stdout, so it can never break the session.

import { readFileSync, writeFileSync, writeSync, mkdirSync, openSync, closeSync, statSync, lstatSync, unlinkSync, renameSync, rmdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  readTranscriptStats,
  contextWindowLimit,
  validContextWindowSize,
  formatStatusLine,
  currentHhMmSs,
  readRateLimitsCache,
} from '../lib/transcript-stats.js';
import { CURRENT_VERSION, getLatestVersion, isNewerVersion } from '../lib/update-check.js';
import { captureRegularFileSnapshot, isOlderThan, writeFileAtomic } from '../lib/fsutil.js';
import {
  acquireLease, leaseOwned, pathIdentity, releaseLease, samePathIdentity, waitForLeaseTestInterlock,
  streamDirectoryEntries, removePathIfUnchangedRecoverable,
} from '../lib/lease-lock.js';

const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

// Throttle state for the chat audit-trail. The primary dedup is per-message
// via requestId (every assistant entry of the same turn shares it), so this
// time-throttle is a safety net only. Default 10s — short enough to never
// suppress the next real turn, long enough to ignore odd hook bursts.
const STAMP_THROTTLE_PATH =
  process.env.CAH_STAMP_THROTTLE_PATH ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'stamp-state', 'last-stamp.json');
const STAMP_MIN_INTERVAL_MS =
  parseInt(process.env.CAH_STAMP_MIN_INTERVAL_MS || '', 10) || 10_000;
const MAX_STAMP_SESSIONS = 64;
const MAX_FINGERPRINT_LENGTH = 512;
const FALLBACK_SESSION_KEY = '__no_session__';
const STAMP_STATE_PREFIX = '.session-';
const STAMP_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP_LOCK_CLAIM_TTL_MS = 30_000;
const UPDATE_CHECK_CACHE =
  process.env.CAH_UPDATE_CHECK_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');

const UPDATE_MARKER_PREFIX = 'cah-update-shown-';
const UPDATE_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_MARKER_CLAIM_TTL_MS = 30_000;
const UPDATE_MARKER_MAX_SESSIONS = 64;
const UPDATE_MARKER_NAME_RE = /^cah-update-shown-[a-f0-9]{64}$/;
const UPDATE_MARKER_SCAN_CAP = UPDATE_MARKER_MAX_SESSIONS * 3 + 8;
const MIGRATION_SCAN_CAP = 256;
const UPDATE_MARKER_NAMESPACE = 'update-markers';
const STAMP_NAMESPACE = 'stamp-state';
const STAMP_PENDING_TTL_MS = positiveEnvMs('CAH_STAMP_PENDING_TTL_MS', 30_000);
const ANONYMOUS_CLAIM_TTL_MS = 1000;
const CAPACITY_TX_VERSION = 1;
function positiveEnvMs(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cacheRoot(home) { return join(home, '.claude', 'cah-bin', 'cache'); }
function updateMarkerNamespace(home) { return join(cacheRoot(home), UPDATE_MARKER_NAMESPACE); }
function stampNamespace(path) {
  const parent = dirname(path);
  return basename(parent) === STAMP_NAMESPACE ? parent : join(parent, STAMP_NAMESPACE);
}

function capacityTransactionPath(markerDir) {
  return join(dirname(markerDir), `.${basename(markerDir)}-capacity-transaction`);
}

function identityKey(identity) {
  if (!identity) return null;
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeNs,
    identity.nlink, identity.contentDigest, identity.isFile, identity.isDirectory,
    identity.isSymbolicLink].map((value) => String(value)).join(':');
}

function capacityStatePath(markerDir) { return join(capacityTransactionPath(markerDir), 'transaction.json'); }

function readCapacityState(markerDir) {
  const txDir = capacityTransactionPath(markerDir);
  const txIdentity = pathIdentity(txDir);
  if (!txIdentity) return undefined;
  if (!txIdentity.isDirectory) return null;
  try {
    const state = JSON.parse(readFileSync(capacityStatePath(markerDir), 'utf8'));
    if (state?.version !== CAPACITY_TX_VERSION
        || typeof state.marker !== 'string' || typeof state.victim !== 'string'
        || typeof state.victimKey !== 'string' || typeof state.markerBeforeKey !== 'string'
        || typeof state.nonce !== 'string') return null;
    return state;
  } catch {
    if (pathIdentity(join(txDir, 'victim'))) return null;
    try { unlinkSync(capacityStatePath(markerDir)); } catch { /* preserve an unreadable slot */ }
    try { rmdirSync(txDir); } catch { /* preserve an unreadable slot */ }
    return undefined;
  }
}

function cleanupCapacityState(markerDir) {
  try { unlinkSync(capacityStatePath(markerDir)); } catch { return false; }
  try { rmdirSync(capacityTransactionPath(markerDir)); } catch { /* retry can finish it */ }
  return true;
}

function markerPublicationMatches(state) {
  const current = pathIdentity(state.marker);
  if (!current?.isFile || identityKey(current) === state.markerBeforeKey) return false;
  try {
    const record = JSON.parse(readFileSync(state.marker, 'utf8'));
    return record && (record.nonce === state.nonce || record.token === state.nonce);
  } catch { return false; }
}

function restoreCapacityVictim(state) {
  const slot = join(capacityTransactionPath(dirname(state.marker)), 'victim');
  if (!pathIdentity(slot)) return Boolean(pathIdentity(state.victim));
  if (!pathIdentity(state.victim)) {
    try { renameSync(slot, state.victim); return true; } catch { return false; }
  }
  try { unlinkSync(slot); return true; } catch { return false; }
}

function finishCapacityEviction(markerDir, state) {
  const slot = join(capacityTransactionPath(markerDir), 'victim');
  try {
    if (!pathIdentity(slot)) {
      const victim = pathIdentity(state.victim);
      if (victim && identityKey(victim) === state.victimKey) renameSync(state.victim, slot);
    }
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_FINAL_UNLINK_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE === '1')) {
      const error = new Error('test-only final unlink failure');
      error.code = 'EACCES';
      throw error;
    }
    if (pathIdentity(slot)) unlinkSync(slot);
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-final-unlink'
          || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-final-unlink')) process.exit(95);
    return cleanupCapacityState(markerDir);
  } catch {
    try {
      if (!markerPublicationMatches(state)
          && pathIdentity(slot) && !pathIdentity(state.victim)) renameSync(slot, state.victim);
    } catch { /* retain the fixed slot for restart reconciliation */ }
    return false;
  }
}

function reconcileCapacityTransaction(markerDir) {
  const state = readCapacityState(markerDir);
  if (state === undefined) return { ok: true, state: null };
  if (!state) return { ok: false, state: null };
  if (markerPublicationMatches(state)) return { ok: finishCapacityEviction(markerDir, state), state };
  const restored = restoreCapacityVictim(state);
  return { ok: restored && cleanupCapacityState(markerDir), state };
}

function directLegacyMarkerPrefix(name) {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name.startsWith(UPDATE_MARKER_PREFIX) && name.length > UPDATE_MARKER_PREFIX.length
    ? UPDATE_MARKER_PREFIX : null;
}

function isSafeCurrentMarkerName(name, prefix, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  const expected = `${prefix}${sessionId}`;
  return expected === name && directLegacyMarkerPrefix(expected) === prefix;
}

function removeLegacyIfUnchanged(path, expected) {
  try {
    const current = pathIdentity(path);
    if (!current?.isFile || !samePathIdentity(expected, current)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function migrateLegacyFile(source, target, sourceStat) {
  if (source === target) return true;
  try {
    const targetStat = lstatSync(target, { bigint: true });
    if (!targetStat.isFile()) return;
    removeLegacyIfUnchanged(source, sourceStat);
    return;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return;
  }
  let data;
  try { data = readFileSync(source); } catch { return; }
  let fd = null;
  try {
    fd = openSync(target, 'wx');
    writeSync(fd, data);
    closeSync(fd);
    fd = null;
    if (samePathIdentity(sourceStat, pathIdentity(source))) removeLegacyIfUnchanged(source, sourceStat);
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function migrateLegacyClaim(source, target, leaseOptions = {}) {
  if (source === target) return true;
  try {
    if (pathIdentity(target)) {
      const stale = acquireLease(source, {
        staleAfterMs: leaseOptions.staleAfterMs || UPDATE_MARKER_CLAIM_TTL_MS,
        fenceSuffix: '.taken-',
        interlockPhase: leaseOptions.interlockPhase || 'legacy-claim-reclaim',
        releaseInterlockPhase: leaseOptions.releaseInterlockPhase || 'legacy-claim-release',
        testLeaseEnv: leaseOptions.testLeaseEnv || 'CAH_UPDATE_OWNER_MAX_LEASE_MS',
      });
      if (stale) releaseLease(stale);
      return Boolean(stale);
    }
    const sourceStat = pathIdentity(source);
    if (!sourceStat?.isDirectory) return;
    renameSync(source, target);
    return true;
  } catch { /* preserve a live legacy claim */ }
  return false;
}

function migrateLegacyMarkers(home, markerDir, sessionId) {
  const legacyDir = join(home, '.claude');
  const flatDir = cacheRoot(home);
  try { mkdirSync(markerDir, { recursive: true }); } catch { return; }
  const hashName = `${UPDATE_MARKER_PREFIX}${sessionHash(sessionId)}`;
  const rawName = typeof sessionId === 'string' && sessionId.length > 0
    && !sessionId.includes('/') && !sessionId.includes('\\') && !sessionId.includes('\0')
    ? `${UPDATE_MARKER_PREFIX}${sessionId}` : null;
  const claimPrefix = '.cah-marker-claim-';
  const directClaims = [
    { sourceName: `${claimPrefix}${hashName}`, targetName: `${claimPrefix}${hashName}` },
    ...(rawName ? [{ sourceName: `${claimPrefix}${rawName}`, targetName: `${claimPrefix}${hashName}` }] : []),
  ];
  let currentLegacyClaimBlocked = false;
  for (const sourceRoot of [flatDir, legacyDir]) {
    for (const { sourceName, targetName } of directClaims) {
      const source = join(sourceRoot, sourceName);
      const target = join(markerDir, targetName);
      try {
        if (pathIdentity(source)) {
          const migrated = migrateLegacyClaim(source, target);
          if (!migrated && pathIdentity(source)) currentLegacyClaimBlocked = true;
        }
      } catch { currentLegacyClaimBlocked = true; }
    }
  }
  const direct = [join(flatDir, hashName), join(legacyDir, hashName), ...(rawName ? [join(legacyDir, rawName)] : [])];
  for (const source of direct) {
    const name = basename(source);
    const targetName = name === rawName ? hashName : name;
    try {
      const sourceStat = pathIdentity(source);
      if (sourceStat?.isFile) migrateLegacyFile(source, join(markerDir, targetName), sourceStat);
    } catch { /* best effort */ }
  }
  const sentinel = join(markerDir, '.migration-v1');
  if (pathIdentity(sentinel)) return { currentLegacyClaimBlocked };
  streamDirectoryEntries(flatDir, MIGRATION_SCAN_CAP, (entry) => {
    const name = entry.name;
    const suffix = name.startsWith(UPDATE_MARKER_PREFIX) ? name.slice(UPDATE_MARKER_PREFIX.length) : null;
    const claimNamePrefix = `.cah-marker-claim-${UPDATE_MARKER_PREFIX}`;
    const claimSuffix = name.startsWith(claimNamePrefix) ? name.slice(claimNamePrefix.length) : null;
    if (suffix !== null && /^[a-f0-9]{64}$/.test(suffix) && entry.isFile()) {
      const source = join(flatDir, name);
      const stat = pathIdentity(source);
      if (stat?.isFile) migrateLegacyFile(source, join(markerDir, name), stat);
    } else if (claimSuffix !== null && /^[a-f0-9]{64}$/.test(claimSuffix) && entry.isDirectory()) {
      migrateLegacyClaim(join(flatDir, name), join(markerDir, name));
    }
  });
  streamDirectoryEntries(legacyDir, MIGRATION_SCAN_CAP, (entry) => {
    const name = entry.name;
    const suffix = name.startsWith(UPDATE_MARKER_PREFIX) ? name.slice(UPDATE_MARKER_PREFIX.length) : null;
    if (suffix !== null && /^[a-f0-9]{64}$/.test(suffix) && entry.isFile()) {
      const source = join(legacyDir, name);
      const stat = pathIdentity(source);
      if (stat?.isFile) migrateLegacyFile(source, join(markerDir, name), stat);
    }
  });
  try { writeFileSync(sentinel, 'v1\n', { flag: 'wx' }); } catch { /* another hook won */ }
  return { currentLegacyClaimBlocked };
}

function pruneStaleMarkers(markerDir, nowMs, protectedMarker = null) {
  streamDirectoryEntries(markerDir, UPDATE_MARKER_SCAN_CAP, (entry) => {
    const name = entry.name;
    if (!UPDATE_MARKER_NAME_RE.test(name) || !entry.isFile()) return;
    const p = join(markerDir, name);
    if (p === protectedMarker) return;
    try {
      const stat = pathIdentity(p);
      if (!stat?.isFile) return;
      if (isOlderThan(stat, nowMs, UPDATE_MARKER_TTL_MS)) {
        const claim = acquireUpdateMarkerClaim(p, nowMs);
        if (!claim) return;
        try {
          const current = pathIdentity(p);
          if (current?.isFile && isOlderThan(current, nowMs, UPDATE_MARKER_TTL_MS)) {
            removePathIfUnchangedRecoverable(p, current, 'marker-remove');
          }
        } finally {
          releaseUpdateMarkerClaim(claim);
        }
        return;
      }
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  });
}

function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function updateMarkerOwner(nowMs) {
  const token = randomUUID();
  return { pid: process.pid, token, nonce: token, timestamp: nowMs, claimedAt: nowMs };
}

function acquireUpdateMarkerClaim(marker, nowMs) {
  const claimPath = join(dirname(marker), `.cah-marker-claim-${basename(marker)}`);
  const lease = acquireLease(claimPath, {
    nowMs,
    staleAfterMs: UPDATE_MARKER_CLAIM_TTL_MS,
    fenceSuffix: '.taken-',
    interlockPhase: 'claim-reclaim',
    releaseInterlockPhase: 'claim-release',
    testLeaseEnv: 'CAH_UPDATE_OWNER_MAX_LEASE_MS',
    owner: updateMarkerOwner(nowMs),
  });
  return lease ? { marker, claimPath, owner: lease.owner, lease } : null;
}

function acquireUpdateMarkerCapacityLease(markerDir, nowMs) {
  return acquireLease(join(markerDir, '.cah-marker-capacity-update'), {
    nowMs,
    staleAfterMs: UPDATE_MARKER_CLAIM_TTL_MS,
    fenceSuffix: '.taken-',
    interlockPhase: 'marker-capacity-lease-reclaim',
    releaseInterlockPhase: 'marker-capacity-lease-release',
    testLeaseEnv: 'CAH_UPDATE_OWNER_MAX_LEASE_MS',
  });
}

function reconcileLegacyCapacityFences(markerDir) {
  const fenceSuffix = '.cah-capacity-fence';
  streamDirectoryEntries(markerDir, UPDATE_MARKER_SCAN_CAP, (entry) => {
    if (!entry.name.endsWith(fenceSuffix)) return;
    const markerName = entry.name.slice(0, -fenceSuffix.length);
    if (!UPDATE_MARKER_NAME_RE.test(markerName) || !entry.isFile()) return;
    const fence = join(markerDir, entry.name);
    const marker = join(markerDir, markerName);
    try {
      if (!pathIdentity(marker)) renameSync(fence, marker);
      else unlinkSync(fence);
    } catch { /* preserve the bounded legacy fence for the next pass */ }
  });
}

function prepareCapacityEviction(markerDir, marker, markerBefore, nonce, nowMs, excludedPath = null) {
  const result = reconcileCapacityTransaction(markerDir);
  if (!result.ok) return null;
  reconcileLegacyCapacityFences(markerDir);
  let count = 0;
  let oldest = null;
  const scan = streamDirectoryEntries(markerDir, UPDATE_MARKER_SCAN_CAP, (entry) => {
    if (!UPDATE_MARKER_NAME_RE.test(entry.name) || !entry.isFile()) return;
    const p = join(markerDir, entry.name);
    if (p === marker || p === excludedPath) return;
    try {
      const stat = pathIdentity(p);
      if (stat?.isFile && !isOlderThan(stat, nowMs, UPDATE_MARKER_TTL_MS)) {
        count += 1;
        if (!oldest || stat.mtimeNs < oldest.mtimeNs) oldest = { path: p, identity: stat };
      }
    } catch { /* best effort */ }
  });
  if (!scan.complete || count < UPDATE_MARKER_MAX_SESSIONS || !oldest) return scan.complete
    ? { state: null, victimClaim: null } : null;
  const victimClaim = acquireUpdateMarkerClaim(oldest.path, nowMs);
  if (!victimClaim) return null;
  const txDir = capacityTransactionPath(markerDir);
  const txState = capacityStatePath(markerDir);
  try {
    mkdirSync(txDir, { recursive: true });
    if (pathIdentity(txState)) {
      releaseUpdateMarkerClaim(victimClaim);
      return null;
    }
    writeFileSync(txState, JSON.stringify({
      version: CAPACITY_TX_VERSION,
      marker,
      markerBeforeKey: identityKey(markerBefore) || 'absent',
      nonce,
      victim: oldest.path,
      victimKey: identityKey(oldest.identity),
    }) + '\n', { flag: 'wx', mode: 0o600 });
    waitForLeaseTestInterlock('marker-capacity');
    if (!samePathIdentity(oldest.identity, pathIdentity(oldest.path))) {
      cleanupCapacityState(markerDir);
      releaseUpdateMarkerClaim(victimClaim);
      return prepareCapacityEviction(markerDir, marker, markerBefore, nonce, nowMs, oldest.path);
    }
    renameSync(oldest.path, join(txDir, 'victim'));
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-victim-rename'
          || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-victim-rename')) process.exit(93);
    const state = readCapacityState(markerDir);
    if (!state || identityKey(pathIdentity(join(txDir, 'victim'))) !== state.victimKey) {
      if (state) restoreCapacityVictim(state);
      cleanupCapacityState(markerDir);
      releaseUpdateMarkerClaim(victimClaim);
      return null;
    }
    return { state, victimClaim };
  } catch {
    try {
      const state = readCapacityState(markerDir);
      if (state && !markerPublicationMatches(state)) restoreCapacityVictim(state);
      if (pathIdentity(txState) && !pathIdentity(join(txDir, 'victim'))) cleanupCapacityState(markerDir);
    } catch { /* preserve the fixed slot for reconciliation */ }
    releaseUpdateMarkerClaim(victimClaim);
    return null;
  }
}

function abortCapacityEviction(markerDir, state) {
  if (!state) return true;
  if (markerPublicationMatches(state)) return finishCapacityEviction(markerDir, state);
  return restoreCapacityVictim(state) && cleanupCapacityState(markerDir);
}

function updateMarkerClaimOwned(claim) {
  return Boolean(claim?.lease && leaseOwned(claim.lease));
}

function releaseUpdateMarkerClaim(claim) {
  if (!claim?.lease) return;
  const capacityLease = claim.capacityLease;
  const victimClaim = claim.victimClaim;
  claim.capacityLease = null;
  claim.victimClaim = null;
  try {
    releaseLease(claim.lease);
  } finally {
    try {
      if (victimClaim) releaseUpdateMarkerClaim(victimClaim);
    } finally {
      if (capacityLease) releaseLease(capacityLease);
    }
  }
}

function markUpdateDelivered(claim) {
  if (!updateMarkerClaimOwned(claim)) return false;
  if (process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-durable'
        || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-marker'
        || process.env.CAH_TEST_ONLY_MARKER_WRITE_FAILURE === 'crash')) {
    if (claim.capacityTransaction) abortCapacityEviction(dirname(claim.marker), claim.capacityTransaction);
    process.exit(92);
  }
  try {
    const expectedDestination = captureRegularFileSnapshot(claim.marker).expectedDestination;
    if (expectedDestination.exists && !isOlderThan(expectedDestination.identity, Date.now(), UPDATE_MARKER_TTL_MS)) return false;
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_MARKER_WRITE_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_MARKER_STATE_WRITE_FAILURE === '1')) return false;
    writeFileAtomic(
      claim.marker,
      JSON.stringify({ nonce: claim.owner.nonce || claim.owner.token, deliveredAt: Date.now() }) + '\n',
      { expectedDestination },
    );
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-marker-publish'
          || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-marker-publish')) process.exit(94);
    return true;
  } catch { return false; }
}

function claimUpdateMarker(markerDir, sessionId, nowMs) {
  const marker = join(markerDir, `${UPDATE_MARKER_PREFIX}${sessionHash(sessionId)}`);
  try {
    mkdirSync(markerDir, { recursive: true });
    const capacityLease = acquireUpdateMarkerCapacityLease(markerDir, nowMs);
    if (!capacityLease) return null;
    if (!reconcileCapacityTransaction(markerDir).ok) {
      releaseLease(capacityLease);
      return null;
    }
    try {
      const markerStat = pathIdentity(marker);
      if (markerStat && !markerStat.isFile) { releaseLease(capacityLease); return null; }
      if (markerStat && !isOlderThan(markerStat, nowMs, UPDATE_MARKER_TTL_MS)) { releaseLease(capacityLease); return null; }
    } catch (statError) {
      if (!statError || statError.code !== 'ENOENT') { releaseLease(capacityLease); return null; }
    }
    const claim = acquireUpdateMarkerClaim(marker, nowMs);
    if (!claim) { releaseLease(capacityLease); return null; }
    try {
      claim.capacityLease = capacityLease;
      try {
        const markerStat = pathIdentity(marker);
        if (markerStat && !markerStat.isFile) {
          releaseUpdateMarkerClaim(claim);
          return null;
        }
        if (markerStat && !isOlderThan(markerStat, nowMs, UPDATE_MARKER_TTL_MS)) {
          releaseUpdateMarkerClaim(claim);
          return null;
        }
      } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== 'ENOENT') {
          releaseUpdateMarkerClaim(claim);
          return null;
        }
      }
      const capacity = prepareCapacityEviction(
        markerDir,
        marker,
        pathIdentity(marker),
        claim.owner.nonce || claim.owner.token,
        nowMs,
      );
      if (!capacity) {
        releaseUpdateMarkerClaim(claim);
        return null;
      }
      claim.capacityTransaction = capacity.state;
      claim.victimClaim = capacity.victimClaim;
      return claim;
    } catch {
      releaseUpdateMarkerClaim(claim);
      return null;
    }
  } catch {
    return null;
  }
}

function buildUpdateNotice(payload, nowMs) {
  const sessionId = payload.session_id;
  if (!sessionId) return null;

  const home = process.env.CAH_STAMP_HINT_HOME || homedir();
  const markerDir = updateMarkerNamespace(home);
  const markerMigration = migrateLegacyMarkers(home, markerDir, sessionId);
  if (markerMigration?.currentLegacyClaimBlocked) return null;
  if (payload.hook_event_name !== 'Stop') return null;
  const protectedMarker = process.env.CAH_TEST_ONLY === '1'
    && process.env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE === 'marker-remove'
    ? null : join(markerDir, `${UPDATE_MARKER_PREFIX}${sessionHash(sessionId)}`);
  pruneStaleMarkers(markerDir, nowMs, protectedMarker);

  let latest = null;
  try {
    latest = getLatestVersion(UPDATE_CHECK_CACHE);
  } catch {
    return null;
  }
  if (!isNewerVersion(CURRENT_VERSION, latest)) return null;

  try {
    const claim = claimUpdateMarker(markerDir, sessionId, nowMs);
    if (!claim) return null;
    return {
      claim,
      text: `\n${String.fromCodePoint(0x1F535)} cc-arch-hands v${latest} is out (you're on v${CURRENT_VERSION}). Update:\n` +
        '  global: npm install -g cc-arch-hands@latest && npx cah reinstall\n' +
        '  local:  npm install cc-arch-hands@latest && npx cah reinstall --local',
    };
  } catch {
    // best-effort — worst case the notice repeats next turn
  }

  return null;
}

function sessionKey(sessionId) {
  return typeof sessionId === 'string' ? sessionId : FALLBACK_SESSION_KEY;
}

function normalizeRequestId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function requestIdDigest(value) {
  const normalized = normalizeRequestId(value);
  return normalized === null ? null : createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function requestIdsEqual(last, current) {
  const normalized = normalizeRequestId(current);
  if (normalized === null || typeof last.requestId !== 'string') return false;
  if (last.requestIdHash === true) return last.requestId === requestIdDigest(normalized);
  return last.requestId === normalized;
}

function sessionStatePath(path, sessionId) {
  return join(stampNamespace(path), `${basename(path)}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`);
}

function migrateLegacyStampState(path, home, sessionId) {
  const namespace = stampNamespace(path);
  try { mkdirSync(namespace, { recursive: true }); } catch { return; }
  const prefix = `${basename(path)}${STAMP_STATE_PREFIX}`;
  const stateName = `${basename(path)}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`;
  const lockName = `${stateName}.lock`;
  const roots = [...new Set([
    dirname(path),
    cacheRoot(home),
    basename(dirname(path)) === STAMP_NAMESPACE ? dirname(dirname(path)) : null,
  ].filter(Boolean))];
  const targetState = join(namespace, stateName);
  const targetLock = join(namespace, lockName);
  let currentLegacyLockBlocked = false;

  for (const root of roots) {
    const sourceState = join(root, stateName);
    const sourceLock = join(root, lockName);
    try {
      const stateStat = pathIdentity(sourceState);
      if (stateStat?.isFile) migrateLegacyFile(sourceState, targetState, stateStat);
      const lockStat = pathIdentity(sourceLock);
      if (lockStat?.isDirectory) {
        const migrated = migrateLegacyClaim(sourceLock, targetLock, {
          staleAfterMs: STAMP_LOCK_CLAIM_TTL_MS,
          testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
          interlockPhase: 'legacy-lock-reclaim',
          releaseInterlockPhase: 'legacy-lock-release',
        });
        if (!migrated && pathIdentity(sourceLock)) currentLegacyLockBlocked = true;
      }
    } catch { currentLegacyLockBlocked = true; }
  }

  const sentinel = join(namespace, '.migration-v1');
  if (pathIdentity(sentinel)) return { currentLegacyLockBlocked };
  for (const root of roots) {
    streamDirectoryEntries(root, MIGRATION_SCAN_CAP, (entry) => {
      const name = entry.name;
      if (name.startsWith(prefix) && name.endsWith('.json') && !name.endsWith('.json.lock') && entry.isFile()) {
        const source = join(root, name);
        const stat = pathIdentity(source);
        if (stat?.isFile) migrateLegacyFile(source, join(namespace, name), stat);
      } else if (name.startsWith(prefix) && name.endsWith('.json.lock') && entry.isDirectory()) {
        migrateLegacyClaim(join(root, name), join(namespace, name), {
          staleAfterMs: STAMP_LOCK_CLAIM_TTL_MS,
          testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
          interlockPhase: 'legacy-lock-reclaim',
          releaseInterlockPhase: 'legacy-lock-release',
        });
      }
    });
  }
  try { writeFileSync(sentinel, 'v1\n', { flag: 'wx' }); } catch { /* another hook won */ }
  return { currentLegacyLockBlocked };
}

function stampRecord(value) {
  if (!value || typeof value !== 'object') {
    return { ts: null, requestId: null, fingerprint: null, deliveryState: 'delivered' };
  }
  return {
    ts: typeof value.lastStampedAt === 'number' ? value.lastStampedAt : null,
    requestId: typeof value.lastStampedRequestId === 'string'
      ? value.lastStampedRequestId
      : null,
    requestIdHash: value.requestIdEncoding === 'sha256' || value.version >= 3,
    fingerprint: typeof value.lastStampedTranscript === 'string'
      ? value.lastStampedTranscript.slice(0, MAX_FINGERPRINT_LENGTH)
      : null,
    deliveryState: value.deliveryState === 'pending' ? 'pending' : 'delivered',
  };
}

function readLastStamp(path, sessionId) {
  const sidecar = sessionStatePath(path, sessionId);
  try {
    const sidecarState = JSON.parse(readFileSync(sidecar, 'utf8'));
    return stampRecord(sidecarState);
  } catch {
  }
  try {
    const legacy = `${path}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`;
    return stampRecord(JSON.parse(readFileSync(legacy, 'utf8')));
  } catch {
  }
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (obj && typeof obj.sessions === 'object' && obj.sessions !== null) {
      return stampRecord(obj.sessions[sessionKey(sessionId)]);
    }
    return stampRecord(obj);
  } catch {
    return { ts: null, requestId: null, fingerprint: null, deliveryState: 'delivered' };
  }
}

function pruneStampSidecars(path, nowMs) {
  const stateDir = stampNamespace(path);
  const prefix = basename(path) + STAMP_STATE_PREFIX;
  const candidates = [];
  streamDirectoryEntries(stateDir, MAX_STAMP_SESSIONS * 2 + 8, (entry) => {
    const name = entry.name;
    if (!name.startsWith(prefix) || !name.endsWith('.json')) return;
    const sidecar = join(stateDir, name);
    try {
      const lstat = lstatSync(sidecar, { bigint: true });
      if (!lstat.isFile() || lstat.nlink !== 1n) return;
      const stat = pathIdentity(sidecar);
      if (isOlderThan(stat, nowMs, STAMP_STATE_TTL_MS)) {
        removePathIfUnchangedRecoverable(sidecar, stat, 'sidecar-prune');
        return;
      }
      candidates.push({ path: sidecar, identity: stat, mtimeNs: stat.mtimeNs });
    } catch {
    }
  });
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  for (const entry of candidates.slice(MAX_STAMP_SESSIONS)) {
    try {
      removePathIfUnchangedRecoverable(entry.path, entry.identity, 'sidecar-prune-capacity');
    } catch { /* best effort */ }
  }
}

function writeLastStamp(path, sessionId, ts, requestId, fingerprint, deliveryState) {
  const sidecar = sessionStatePath(path, sessionId);
  try {
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_STAMP_STATE_WRITE_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_STATE_WRITE_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_STAMP_STATE_WRITE_ERROR === '1')) return false;
    const expectedDestination = captureRegularFileSnapshot(sidecar).expectedDestination;
    writeFileAtomic(
      sidecar,
      JSON.stringify({
        version: 3,
        requestIdEncoding: 'sha256',
        lastStampedAt: ts,
        lastStampedRequestId: typeof requestId === 'string'
          ? requestIdDigest(requestId)
          : null,
        lastStampedTranscript: typeof fingerprint === 'string'
          ? fingerprint.slice(0, MAX_FINGERPRINT_LENGTH)
          : null,
        deliveryState: deliveryState === 'pending' ? 'pending' : 'delivered',
      }) + '\n',
      { expectedDestination },
    );
    pruneStampSidecars(path, ts);
    return true;
  } catch {
    // fail-silent — throttling is best-effort
    return false;
  }
}

function stampLockPath(path, sessionId) {
  return `${sessionStatePath(path, sessionId)}.lock`;
}

function stampLockOwner(nowMs) {
  const token = randomUUID();
  return { pid: process.pid, token, nonce: token, timestamp: nowMs, startedAt: nowMs };
}

function acquireStampLock(path, sessionId, nowMs) {
  const lease = acquireLease(stampLockPath(path, sessionId), {
    nowMs,
    owner: stampLockOwner(nowMs),
    staleAfterMs: STAMP_LOCK_CLAIM_TTL_MS,
    fenceSuffix: '.taken-',
    interlockPhase: 'lock-reclaim',
    releaseInterlockPhase: 'lock-release',
    testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
  });
  return lease;
}

function releaseStampLock(lock) {
  releaseLease(lock);
}

function transcriptFingerprint(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const input = readStdin();
  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return; // malformed JSON — exit silent
  }

  if (payload.stop_hook_active === true) return;

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) return;

  const nowMs = Date.now();
  const stampHome = process.env.CAH_STAMP_HINT_HOME || homedir();
  const stampMigration = migrateLegacyStampState(STAMP_THROTTLE_PATH, stampHome, payload.session_id);
  if (stampMigration?.currentLegacyLockBlocked) return;
  const stampLock = acquireStampLock(STAMP_THROTTLE_PATH, payload.session_id, nowMs);
  if (!stampLock) return;
  let updateNotice = null;
  try {
  const fingerprint = transcriptFingerprint(transcriptPath);
  try {
    updateNotice = buildUpdateNotice(payload, nowMs);
  } catch {
    // fail-silent — the stamp itself must still ship without the notice
  }
  const last = readLastStamp(STAMP_THROTTLE_PATH, payload.session_id);
  const lastAgeMs = last.ts !== null && nowMs >= last.ts ? nowMs - last.ts : null;
  const pendingFresh = last.deliveryState === 'pending'
    && lastAgeMs !== null
    && lastAgeMs <= STAMP_PENDING_TTL_MS;
  const timeSuppressed = last.deliveryState === 'delivered'
    && lastAgeMs !== null
    && lastAgeMs < STAMP_MIN_INTERVAL_MS;

  const time = currentHhMmSs();

  let usedTokens = null;
  let modelId = null;
  let requestId = null;
  try {
    const stats = readTranscriptStats(transcriptPath);
    if (stats) {
      usedTokens = stats.usedTokens;
      modelId = stats.modelId;
      requestId = normalizeRequestId(stats.requestId);
    }
  } catch {
    // transcript missing / unreadable — still emit with time only
  }

  const requestSuppressed = requestId !== null
    && requestIdsEqual(last, requestId)
    && lastAgeMs !== null
    && (pendingFresh || (
      last.deliveryState === 'delivered'
      && lastAgeMs <= STAMP_STATE_TTL_MS
    ));
  const anonymousTurnSuppressed = requestId === null
    && fingerprint !== null
    && fingerprint === last.fingerprint
    && lastAgeMs !== null
    && (pendingFresh || (
      last.deliveryState === 'delivered'
      && lastAgeMs <= ANONYMOUS_CLAIM_TTL_MS
    ));
  if (timeSuppressed || requestSuppressed || anonymousTurnSuppressed) {
    if (updateNotice) {
      if (updateMarkerClaimOwned(updateNotice.claim)) {
        try {
          writeSync(1, JSON.stringify({ continue: true, systemMessage: updateNotice.text }) + '\n');
          if (markUpdateDelivered(updateNotice.claim)) {
            if (updateNotice.claim.capacityTransaction
                && finishCapacityEviction(
                  dirname(updateNotice.claim.marker), updateNotice.claim.capacityTransaction,
                )) updateNotice.claim.capacityTransaction = null;
            pruneStaleMarkers(dirname(updateNotice.claim.marker), Date.now());
          } else if (updateNotice.claim.capacityTransaction) {
            abortCapacityEviction(dirname(updateNotice.claim.marker), updateNotice.claim.capacityTransaction);
          }
        } finally {
          releaseUpdateMarkerClaim(updateNotice.claim);
          updateNotice = null;
        }
      }
    }
    return;
  }

  let cachedState = null;
  try {
    cachedState = readRateLimitsCache(RATE_LIMITS_CACHE, Date.now(), payload.session_id);
  } catch {
    // fail-silent — proceed without session cache
  }
  let envelopeLimit = null;
  try {
    const cw = payload.context_window;
    if (cw && typeof cw === 'object') envelopeLimit = validContextWindowSize(cw.context_window_size);
  } catch {
    // ignore malformed hook envelope
  }
  const limit = modelId
    ? contextWindowLimit(modelId, envelopeLimit || (cachedState && cachedState.contextWindowSize))
    : null;

  const displayName = modelId || null;
  const effectiveUsed = (usedTokens !== null && modelId !== null) ? usedTokens : null;
  const effectiveLimit = (usedTokens !== null && modelId !== null) ? limit : null;

  let fiveHour = null;
  let sevenDay = null;
  try {
    if (cachedState) {
      fiveHour = cachedState.fiveHour;
      sevenDay = cachedState.sevenDay;
    }
  } catch {
    // fail-silent — proceed without rate_limits
  }

  const line = formatStatusLine({
    time,
    displayName,
    usedTokens: effectiveUsed,
    limit: effectiveLimit,
    fiveHour,
    sevenDay,
    bars: false, // chat audit trail stays compact — bars belong on the statusLine
  });
  if (updateNotice && !updateMarkerClaimOwned(updateNotice.claim)) {
    updateNotice = null;
  }
  const out = JSON.stringify({ continue: true, systemMessage: line + (updateNotice ? updateNotice.text : '') });
  if (!writeLastStamp(
    STAMP_THROTTLE_PATH,
    payload.session_id,
    nowMs,
    requestId,
    fingerprint,
    'pending',
  )) return;
  writeSync(1, out + '\n');
  if (updateNotice) {
    if (markUpdateDelivered(updateNotice.claim)) {
      if (updateNotice.claim.capacityTransaction
          && finishCapacityEviction(
            dirname(updateNotice.claim.marker), updateNotice.claim.capacityTransaction,
          )) updateNotice.claim.capacityTransaction = null;
      pruneStaleMarkers(dirname(updateNotice.claim.marker), Date.now());
    } else if (updateNotice.claim.capacityTransaction) {
      abortCapacityEviction(dirname(updateNotice.claim.marker), updateNotice.claim.capacityTransaction);
    }
    releaseUpdateMarkerClaim(updateNotice.claim);
    updateNotice = null;
  }
  writeLastStamp(
    STAMP_THROTTLE_PATH,
    payload.session_id,
    nowMs,
    requestId,
    fingerprint,
    'delivered',
  );
  } finally {
    if (updateNotice) {
      if (updateNotice.claim.capacityTransaction) {
        abortCapacityEviction(dirname(updateNotice.claim.marker), updateNotice.claim.capacityTransaction);
      }
      releaseUpdateMarkerClaim(updateNotice.claim);
    }
    releaseStampLock(stampLock);
  }
}

try {
  main();
} catch {
  /* fail silent */
}

process.exit(0);
