#!/usr/bin/env node
// cah-stamp — Claude Code Stop hook.

import { readFileSync, writeFileSync, writeSync, statSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  readTranscriptStats, contextWindowLimit, validContextWindowSize, formatStatusLine,
  currentHhMmSs, readRateLimitsCache,
} from '../lib/transcript-stats.js';
import { CURRENT_VERSION, getLatestVersion, isNewerVersion } from '../lib/update-check.js';
import { captureRegularFileSnapshot, isOlderThan, writeFileAtomic } from '../lib/fsutil.js';
import { acquireLease, renewLease, pathIdentity, releaseLease, streamDirectoryEntries,
  recoverOwnedFileFences, removeOwnedFileForGeneration, readDirectoryScanStats,
  resetDirectoryScanStats } from '../lib/lease-lock.js';
import {
  sessionHash, markerNamespace, migrateMarkerState, pruneMarkers, claimMarker,
  markerClaimOwned, releaseMarkerClaim, publishMarker, finishMarkerTransaction,
  abortMarkerTransaction, migrateLegacyStateFiles,
} from '../lib/marker-state.js';

const RATE_LIMITS_CACHE = process.env.CAH_RATE_LIMITS_CACHE
  || join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');
const STAMP_THROTTLE_PATH = process.env.CAH_STAMP_THROTTLE_PATH
  || join(homedir(), '.claude', 'cah-bin', 'cache', 'stamp-state', 'last-stamp.json');
const STAMP_MIN_INTERVAL_MS = parseInt(process.env.CAH_STAMP_MIN_INTERVAL_MS || '', 10) || 10_000;
const MAX_STAMP_SESSIONS = 64;
const MAX_FINGERPRINT_LENGTH = 512;
const FALLBACK_SESSION_KEY = '__no_session__';
const STAMP_STATE_PREFIX = '.session-';
const STAMP_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP_LOCK_CLAIM_TTL_MS = 30_000;
const UPDATE_CHECK_CACHE = process.env.CAH_UPDATE_CHECK_CACHE
  || join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');
const UPDATE_MARKER_PREFIX = 'cah-update-shown-';
const UPDATE_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_MARKER_CLAIM_TTL_MS = 30_000;
const UPDATE_MARKER_MAX_SESSIONS = 64;
const UPDATE_MARKER_NAME_RE = /^cah-update-shown-[a-f0-9]{64}$/;
const UPDATE_MARKER_SCAN_CAP = UPDATE_MARKER_MAX_SESSIONS * 3 + 8;
const UPDATE_MARKER_NAMESPACE = 'update-markers';
const STAMP_NAMESPACE = 'stamp-state';
const STAMP_PENDING_TTL_MS = positiveEnvMs('CAH_STAMP_PENDING_TTL_MS', 30_000);
const ANONYMOUS_CLAIM_TTL_MS = 1000;
const STAMP_SIDECAR_FENCE_MARKER = '.cah-stamp-sidecar-';
const STAMP_SIDECAR_RECOVERY_LIMIT = MAX_STAMP_SESSIONS * 2 + 8;

function positiveEnvMs(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stampNamespace(path) {
  const parent = dirname(path);
  return basename(parent) === STAMP_NAMESPACE ? parent : join(parent, STAMP_NAMESPACE);
}

function markerOptions(markerDir, testHooks = {}) {
  return { markerDir, namespace: UPDATE_MARKER_NAMESPACE, prefix: UPDATE_MARKER_PREFIX,
    ttlMs: UPDATE_MARKER_TTL_MS, claimTtlMs: UPDATE_MARKER_CLAIM_TTL_MS,
    maxSessions: UPDATE_MARKER_MAX_SESSIONS, scanCap: UPDATE_MARKER_SCAN_CAP,
    markerNameRe: UPDATE_MARKER_NAME_RE, ownerTestEnv: 'CAH_UPDATE_OWNER_MAX_LEASE_MS',
    testInterlock: testHooks.testInterlock };
}

function sessionKey(sessionId) { return typeof sessionId === 'string' ? sessionId : FALLBACK_SESSION_KEY; }
function normalizeRequestId(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function requestIdDigest(value) {
  const normalized = normalizeRequestId(value);
  return normalized === null ? null : createHash('sha256').update(normalized, 'utf8').digest('hex');
}
function requestIdsEqual(last, current) {
  const normalized = normalizeRequestId(current);
  if (normalized === null || typeof last.requestId !== 'string') return false;
  return last.requestId === (last.requestIdHash ? requestIdDigest(normalized) : normalized);
}
function sessionStatePath(path, sessionId) {
  return join(stampNamespace(path), `${basename(path)}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`);
}

function stampRecord(value) {
  if (!value || typeof value !== 'object') return { ts: null, requestId: null, fingerprint: null, deliveryState: 'delivered' };
  return { ts: typeof value.lastStampedAt === 'number' ? value.lastStampedAt : null,
    requestId: typeof value.lastStampedRequestId === 'string' ? value.lastStampedRequestId : null,
    requestIdHash: value.requestIdEncoding === 'sha256' || value.version >= 3,
    fingerprint: typeof value.lastStampedTranscript === 'string'
      ? value.lastStampedTranscript.slice(0, MAX_FINGERPRINT_LENGTH) : null,
    deliveryState: value.deliveryState === 'pending' ? 'pending' : 'delivered' };
}

function readLastStamp(path, sessionId) {
  const paths = [sessionStatePath(path, sessionId), `${path}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`];
  for (const candidate of paths) {
    try { return stampRecord(JSON.parse(readFileSync(candidate, 'utf8'))); } catch { /* next representation */ }
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return stampRecord(value?.sessions && typeof value.sessions === 'object'
      ? value.sessions[sessionKey(sessionId)] : value);
  } catch { return stampRecord(null); }
}

function acquireSidecarLease(sidecar, nowMs, testInterlock = null) {
  const token = randomUUID();
  return acquireLease(`${sidecar}.lock`, {
    nowMs, owner: { pid: process.pid, token, nonce: token, timestamp: nowMs, startedAt: nowMs },
    staleAfterMs: STAMP_LOCK_CLAIM_TTL_MS, fenceSuffix: '.taken-',
    interlockPhase: 'stamp-sidecar-lock-reclaim', releaseInterlockPhase: 'stamp-sidecar-lock-release',
    testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS', testInterlock,
  });
}

function sameLeasePath(path, lease) {
  return Boolean(typeof path === 'string' && lease?.path && path === lease.path);
}

function sidecarAuthority(lease) {
  const path = lease?.path;
  const token = lease?.owner?.token || lease?.owner?.nonce;
  const generation = lease?.owner?.generation;
  return () => Boolean(path && token && generation && lease.path === path
    && (lease.owner.token || lease.owner.nonce) === token
    && lease.owner.generation === generation && renewLease(lease));
}

function recoverStampSidecarFences(path, currentLease, nowMs, testInterlock = null) {
  const stateDir = stampNamespace(path);
  const prefix = `${basename(path)}${STAMP_STATE_PREFIX}`;
  const fenceMarker = STAMP_SIDECAR_FENCE_MARKER;
  const sidecars = new Set();
  const scan = streamDirectoryEntries(stateDir, STAMP_SIDECAR_RECOVERY_LIMIT, (entry) => {
    if (!entry.name.startsWith(prefix) || !entry.name.includes(fenceMarker)
        || !entry.name.endsWith('.fence')) return;
    const sidecarName = entry.name.slice(0, entry.name.indexOf(fenceMarker));
    if (!sidecarName.startsWith(prefix) || !sidecarName.endsWith('.json')) return;
    sidecars.add(join(stateDir, sidecarName));
  });
  let ok = true;
  for (const sidecar of sidecars) {
    const lock = sameLeasePath(`${sidecar}.lock`, currentLease)
      ? currentLease : acquireSidecarLease(sidecar, nowMs, testInterlock);
    if (!lock) { ok = false; continue; }
    try {
      const authority = sidecarAuthority(lock);
      const recovered = recoverOwnedFileFences(sidecar, lock, {
        marker: fenceMarker, limit: STAMP_SIDECAR_RECOVERY_LIMIT,
        assertOwnership: authority, testInterlock,
      });
      // A capped per-sidecar scan may have recovered known fences while
      // leaving unseen entries for a later invocation.
      if (!recovered.ok && recovered.complete) ok = false;
    } catch { ok = false; }
    finally { if (!sameLeasePath(`${sidecar}.lock`, currentLease)) releaseLease(lock); }
  }
  return scan.complete && ok;
}

function removeStampSidecar(sidecar, expected, currentLease, nowMs, phase, testInterlock = null,
  options = {}) {
  const lock = sameLeasePath(`${sidecar}.lock`, currentLease)
    ? currentLease : acquireSidecarLease(sidecar, nowMs, testInterlock);
  if (!lock) return false;
  try {
    const assertOwnership = sidecarAuthority(lock);
    if (options.recoverFences !== false) {
      const recovered = recoverOwnedFileFences(sidecar, lock, {
        marker: STAMP_SIDECAR_FENCE_MARKER, limit: STAMP_SIDECAR_RECOVERY_LIMIT,
        assertOwnership, testInterlock,
      });
      if (!recovered.ok && recovered.complete) return false;
    }
    const current = pathIdentity(sidecar);
    if (!current || (phase === 'sidecar-prune' && !isOlderThan(current, nowMs, STAMP_STATE_TTL_MS))) {
      return false;
    }
    const result = removeOwnedFileForGeneration(sidecar, expected, lock, phase, {
      marker: STAMP_SIDECAR_FENCE_MARKER, assertOwnership, testInterlock,
    });
    return result.ok;
  } catch { return false; }
  finally { if (!sameLeasePath(`${sidecar}.lock`, currentLease)) releaseLease(lock); }
}

function pruneStampSidecars(path, nowMs, lease, testInterlock = null) {
  const stateDir = stampNamespace(path);
  const prefix = basename(path) + STAMP_STATE_PREFIX;
  // Partial recovery is useful progress; the bounded sidecar scan below also
  // handles known stale records. Incomplete scans only suppress capacity
  // decisions, never safe cleanup of entries already observed.
  recoverStampSidecarFences(path, lease, nowMs, testInterlock);
  const statsPath = process.env.CAH_TEST_ONLY === '1'
    ? process.env.CAH_TEST_ONLY_SCAN_STATS_PATH : undefined;
  if (statsPath) resetDirectoryScanStats();
  try {
    return pruneStampSidecarsScan(path, nowMs, lease, testInterlock);
  } finally {
    if (statsPath) {
      try { writeFileSync(statsPath, JSON.stringify(readDirectoryScanStats())); } catch { /* best effort */ }
    }
  }
}

function pruneStampSidecarsScan(path, nowMs, lease, testInterlock = null) {
  const stateDir = stampNamespace(path);
  const prefix = basename(path) + STAMP_STATE_PREFIX;
  const candidates = [];
  let owned = true;
  const scan = streamDirectoryEntries(stateDir, MAX_STAMP_SESSIONS * 2 + 8, (entry) => {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) return;
    const sidecar = join(stateDir, entry.name);
    try {
      const stat = lstatSync(sidecar, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) return;
      const identity = pathIdentity(sidecar);
      if (!identity) return;
      if (isOlderThan(identity, nowMs, STAMP_STATE_TTL_MS)) {
        removeStampSidecar(sidecar, identity, lease, nowMs, 'sidecar-prune', testInterlock,
          { recoverFences: false });
        if (!renewLease(lease)) owned = false;
      } else candidates.push({ path: sidecar, identity, mtimeNs: identity.mtimeNs });
    } catch { /* preserve indeterminate state */ }
  });
  if (!scan.complete || !owned) return owned;
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  for (const entry of candidates.slice(MAX_STAMP_SESSIONS)) {
    try {
      removeStampSidecar(entry.path, entry.identity, lease, nowMs,
        'sidecar-prune-capacity', testInterlock, { recoverFences: false });
    } catch { /* best effort */ }
  }
  return renewLease(lease);
}

function writeLastStamp(path, sessionId, ts, requestId, fingerprint, deliveryState, lease,
  testInterlock = null) {
  const sidecar = sessionStatePath(path, sessionId);
  try {
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_STAMP_STATE_WRITE_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_STATE_WRITE_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_STAMP_STATE_WRITE_ERROR === '1')) return false;
    if (!renewLease(lease)) return false;
    const expectedDestination = captureRegularFileSnapshot(sidecar).expectedDestination;
    writeFileAtomic(sidecar, JSON.stringify({ version: 3, requestIdEncoding: 'sha256',
      lastStampedAt: ts, lastStampedRequestId: typeof requestId === 'string' ? requestIdDigest(requestId) : null,
      lastStampedTranscript: typeof fingerprint === 'string' ? fingerprint.slice(0, MAX_FINGERPRINT_LENGTH) : null,
      deliveryState: deliveryState === 'pending' ? 'pending' : 'delivered' }) + '\n', {
      expectedDestination, testInterlock, lifecycleLease: lease,
      assertOwnership: () => renewLease(lease),
    });
    return pruneStampSidecars(path, ts, lease, testInterlock);
  } catch { return false; }
}

function stampLockPath(path, sessionId) { return `${sessionStatePath(path, sessionId)}.lock`; }
function acquireStampLock(path, sessionId, nowMs, testInterlock = null) {
  const token = randomUUID();
  return acquireLease(stampLockPath(path, sessionId), {
    nowMs, owner: { pid: process.pid, token, nonce: token, timestamp: nowMs, startedAt: nowMs },
    staleAfterMs: STAMP_LOCK_CLAIM_TTL_MS, fenceSuffix: '.taken-',
    interlockPhase: 'lock-reclaim', releaseInterlockPhase: 'lock-release',
    testLeaseEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
    testInterlock,
  });
}

function transcriptFingerprint(path) {
  try { const stat = statSync(path, { bigint: true }); return `${stat.size}:${stat.mtimeNs}`; } catch { return null; }
}

function updateMarkerClaimOwned(claim) { return markerClaimOwned(claim); }
function releaseUpdateMarkerClaim(claim) { return releaseMarkerClaim(claim); }
function markUpdateDelivered(claim, markerDir, testHooks = {}) {
  if (!markerClaimOwned(claim)) return false;
  if (process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-durable'
        || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-marker'
        || process.env.CAH_TEST_ONLY_MARKER_WRITE_FAILURE === 'crash')) {
    abortMarkerTransaction(claim);
    process.exit(92);
  }
  const ok = publishMarker(claim,
    JSON.stringify({ nonce: claim.owner.nonce || claim.owner.token, deliveredAt: Date.now() }) + '\n',
    markerOptions(markerDir, testHooks));
  if (ok && process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-marker-publish'
        || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-marker-publish')) process.exit(94);
  return ok;
}

function buildUpdateNotice(payload, nowMs, testHooks = {}) {
  if (!payload.session_id || payload.hook_event_name !== 'Stop') return null;
  const home = process.env.CAH_STAMP_HINT_HOME || homedir();
  const markerDir = markerNamespace(home, UPDATE_MARKER_NAMESPACE);
  const options = markerOptions(markerDir, testHooks);
  const migration = migrateMarkerState({ ...options, home, sessionId: payload.session_id });
  if (migration?.blocked) return null;
  const protectedMarker = testHooks.protectMarker
    ? null : join(markerDir, `${UPDATE_MARKER_PREFIX}${sessionHash(payload.session_id)}`);
  pruneMarkers({ ...options, nowMs, protectedMarker });
  let latest;
  try { latest = getLatestVersion(UPDATE_CHECK_CACHE); } catch { return null; }
  if (!isNewerVersion(CURRENT_VERSION, latest)) return null;
  const claim = claimMarker({ ...options, sessionId: payload.session_id, nowMs });
  return claim ? { claim, markerDir, text: `\n${String.fromCodePoint(0x1F535)} cc-arch-hands v${latest} is out (you're on v${CURRENT_VERSION}). Update:\n` +
    '  global: npm install -g cc-arch-hands@latest && npx cah reinstall\n' +
    '  local:  npm install cc-arch-hands@latest && npx cah reinstall --local' } : null;
}

function settleUpdateNotice(notice, lease, testHooks = {}) {
  if (!notice || !renewLease(lease) || !updateMarkerClaimOwned(notice.claim)) return false;
  try {
    if (markUpdateDelivered(notice.claim, notice.markerDir, testHooks)) {
      finishMarkerTransaction(notice.claim);
      pruneMarkers({ ...markerOptions(notice.markerDir), nowMs: Date.now() });
    } else abortMarkerTransaction(notice.claim);
    return true;
  } finally { releaseUpdateMarkerClaim(notice.claim); }
}

export function main(testHooks = {}) {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (payload.stop_hook_active === true || !payload.transcript_path) return;
  const nowMs = Date.now();
  const stampHome = process.env.CAH_STAMP_HINT_HOME || homedir();
  const stateDir = stampNamespace(STAMP_THROTTLE_PATH);
  const stateName = `${basename(STAMP_THROTTLE_PATH)}${STAMP_STATE_PREFIX}${sessionHash(payload.session_id)}.json`;
  const stampMigration = migrateLegacyStateFiles({
    prefix: `${basename(STAMP_THROTTLE_PATH)}${STAMP_STATE_PREFIX}`,
    namespace: STAMP_NAMESPACE, namespaceDir: stateDir, home: stampHome,
    sessionId: payload.session_id, stateName, lockName: `${stateName}.lock`,
    roots: [...new Set([dirname(STAMP_THROTTLE_PATH), join(stampHome, '.claude', 'cah-bin', 'cache')])],
    ttlMs: STAMP_STATE_TTL_MS, claimTtlMs: STAMP_LOCK_CLAIM_TTL_MS,
    maxSessions: MAX_STAMP_SESSIONS, scanCap: MAX_STAMP_SESSIONS * 3 + 8,
    ownerTestEnv: 'CAH_STAMP_OWNER_MAX_LEASE_MS',
  });
  if (stampMigration?.blocked) return;
  const lock = acquireStampLock(STAMP_THROTTLE_PATH, payload.session_id, nowMs,
    testHooks.testInterlock);
  if (!lock) return;
  let notice = null;
  try {
    // Maintenance also runs on a deduplicated retry so a previous process
    // crash cannot leave a generation fence until the next new turn.
    try { pruneStampSidecars(STAMP_THROTTLE_PATH, nowMs, lock, testHooks.testInterlock); } catch { /* best effort */ }
    const fingerprint = transcriptFingerprint(payload.transcript_path);
    try { notice = buildUpdateNotice(payload, nowMs, testHooks); } catch { notice = null; }
    const last = readLastStamp(STAMP_THROTTLE_PATH, payload.session_id);
    const age = last.ts !== null && nowMs >= last.ts ? nowMs - last.ts : null;
    const pendingFresh = last.deliveryState === 'pending' && age !== null && age <= STAMP_PENDING_TTL_MS;
    const timeSuppressed = last.deliveryState === 'delivered' && age !== null && age < STAMP_MIN_INTERVAL_MS;
    let stats = null;
    try { stats = readTranscriptStats(payload.transcript_path); } catch { /* time-only stamp */ }
    const requestId = normalizeRequestId(stats?.requestId);
    const requestSuppressed = requestId !== null && requestIdsEqual(last, requestId) && age !== null
      && (pendingFresh || (last.deliveryState === 'delivered' && age <= STAMP_STATE_TTL_MS));
    const anonymousSuppressed = requestId === null && fingerprint !== null && fingerprint === last.fingerprint
      && age !== null && (pendingFresh || (last.deliveryState === 'delivered' && age <= ANONYMOUS_CLAIM_TTL_MS));
    if (timeSuppressed || requestSuppressed || anonymousSuppressed) {
      if (notice?.claim && updateMarkerClaimOwned(notice.claim)) {
        if (!renewLease(lock)) return;
        writeSync(1, JSON.stringify({ continue: true, systemMessage: notice.text }) + '\n');
        if (settleUpdateNotice(notice, lock, testHooks)) notice = null;
      }
      return;
    }
    let cached = null;
    try { cached = readRateLimitsCache(RATE_LIMITS_CACHE, Date.now(), payload.session_id, testHooks); } catch { /* best effort */ }
    let envelopeLimit = null;
    try { envelopeLimit = validContextWindowSize(payload.context_window?.context_window_size); } catch { /* ignore */ }
    const limit = stats?.modelId ? contextWindowLimit(stats.modelId, envelopeLimit || cached?.contextWindowSize) : null;
    const line = formatStatusLine({ time: currentHhMmSs(), displayName: stats?.modelId || null,
      usedTokens: stats?.usedTokens !== null && stats?.modelId ? stats.usedTokens : null,
      limit: stats?.usedTokens !== null && stats?.modelId ? limit : null,
      fiveHour: cached?.fiveHour || null, sevenDay: cached?.sevenDay || null, bars: false });
    if (notice && !updateMarkerClaimOwned(notice.claim)) { notice = null; }
    const out = JSON.stringify({ continue: true, systemMessage: line + (notice ? notice.text : '') });
    if (!writeLastStamp(STAMP_THROTTLE_PATH, payload.session_id, nowMs, requestId, fingerprint,
      'pending', lock, testHooks.testInterlock)) return;
    if (!renewLease(lock)) return;
    writeSync(1, out + '\n');
    if (!renewLease(lock)) return;
    if (notice && settleUpdateNotice(notice, lock, testHooks)) notice = null;
    writeLastStamp(STAMP_THROTTLE_PATH, payload.session_id, nowMs, requestId, fingerprint,
      'delivered', lock, testHooks.testInterlock);
  } finally {
    if (notice) { abortMarkerTransaction(notice.claim); releaseUpdateMarkerClaim(notice.claim); }
    releaseLease(lock);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch { /* fail-silent */ }
  process.exit(0);
}
