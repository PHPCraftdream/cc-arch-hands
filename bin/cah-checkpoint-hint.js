#!/usr/bin/env node
// cah-checkpoint-hint — Claude Code Stop hook.
//
// Reads the hook JSON payload from stdin, inspects the session transcript,
// and emits ONE soft systemMessage suggesting /checkpoint when context usage
// crosses 90% of the model's limit. It is deliberately fail-silent: any error,
// missing input, or filesystem hiccup results in `exit 0` with no stdout, so it
// can never break the user's session.

import { mkdirSync, openSync, closeSync, readFileSync, lstatSync, unlinkSync, writeSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readTranscriptStats, contextWindowLimit, readRateLimitsCache, validContextWindowSize } from '../lib/transcript-stats.js';
import {
  acquireLease, leaseOwned, pathIdentity, releaseLease, samePathIdentity,
} from '../lib/lease-lock.js';
import { captureRegularFileSnapshot, isOlderThan, writeFileAtomic } from '../lib/fsutil.js';
import { streamDirectoryEntries, removePathIfUnchangedRecoverable } from '../lib/lease-lock.js';

const THRESHOLD = 0.9;
const THRESHOLD_PCT = Math.round(THRESHOLD * 100);
// Derived from THRESHOLD so the displayed percentage can never drift out of
// sync with the value that actually triggers the hint.
const MESSAGE = JSON.stringify({
  continue: true,
  systemMessage: `[hint] Context at ${THRESHOLD_PCT}%. Run /checkpoint to save state before auto-compact.`,
});

// One marker file per session gates the one-shot hint. They are tiny but never
// removed otherwise, so we sweep stale ones (older than the TTL) on each run.
const MARKER_PREFIX = 'cah-hint-shown-';
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER_CLAIM_TTL_MS = 30_000;
const MARKER_MAX_SESSIONS = 64;
const MARKER_NAME_RE = /^cah-hint-shown-[a-f0-9]{64}$/;
const MARKER_SCAN_CAP = MARKER_MAX_SESSIONS * 3 + 8;
const MIGRATION_SCAN_CAP = 256;
const MARKER_NAMESPACE = 'hint-markers';
const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

function cacheRoot(home) { return join(home, '.claude', 'cah-bin', 'cache'); }
function markerNamespace(home) { return join(cacheRoot(home), MARKER_NAMESPACE); }

function pruneStaleMarkers(markerDir, nowMs, protectedMarker = null) {
  streamDirectoryEntries(markerDir, MARKER_SCAN_CAP, (entry) => {
    const name = entry.name;
    if (!MARKER_NAME_RE.test(name) || !entry.isFile()) return;
    const p = join(markerDir, name);
    if (p === protectedMarker) return;
    try {
      const stat = pathIdentity(p);
      if (!stat?.isFile) return;
      if (isOlderThan(stat, nowMs, MARKER_TTL_MS)) {
        const claim = acquireMarkerClaim(p, nowMs);
        if (!claim) return;
        try {
          const current = pathIdentity(p);
          if (current?.isFile && isOlderThan(current, nowMs, MARKER_TTL_MS)) {
            removePathIfUnchangedRecoverable(p, current, 'marker-remove');
          }
        } finally {
          releaseMarkerClaim(claim);
        }
      }
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  });
}

// Capacity is a reservation, not hygiene. The caller has already acquired
// the new session's marker claim, so a competing caller for that session fails
// without evicting an unrelated fresh marker.
function reserveMarkerCapacity(markerDir, nowMs, protectedMarker = null) {
  let count = 0;
  let oldest = null;
  streamDirectoryEntries(markerDir, MARKER_SCAN_CAP, (entry) => {
    if (!MARKER_NAME_RE.test(entry.name) || !entry.isFile()) return;
    const p = join(markerDir, entry.name);
    if (p === protectedMarker) return;
    try {
      const stat = pathIdentity(p);
      if (stat?.isFile && !isOlderThan(stat, nowMs, MARKER_TTL_MS)) {
        count += 1;
        if (!oldest || stat.mtimeNs < oldest.mtimeNs) oldest = { path: p, identity: stat };
      }
    } catch { /* best effort */ }
  });
  if (count < MARKER_MAX_SESSIONS || !oldest) return true;
  let victimClaim;
  try { victimClaim = acquireMarkerClaim(oldest.path, nowMs); } catch { victimClaim = null; }
  if (!victimClaim) return false;
  try {
    const current = pathIdentity(oldest.path);
    if (!current?.isFile || isOlderThan(current, nowMs, MARKER_TTL_MS)) return true;
    return removePathIfUnchangedRecoverable(oldest.path, current, 'marker-capacity').ok;
  } catch {
    return false;
  } finally {
    releaseMarkerClaim(victimClaim);
  }
}

function directLegacyMarkerPrefix(name) {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name.startsWith(MARKER_PREFIX) && name.length > MARKER_PREFIX.length
    ? MARKER_PREFIX : null;
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

function migrateLegacyClaim(source, target) {
  try {
    if (pathIdentity(target)) return;
    const sourceStat = pathIdentity(source);
    if (!sourceStat?.isDirectory) return;
    renameSync(source, target);
  } catch { /* best effort; a live claim remains authoritative */ }
}

function migrateLegacyMarkers(home, markerDir, sessionId) {
  const legacyDir = join(home, '.claude');
  const flatDir = cacheRoot(home);
  try { mkdirSync(markerDir, { recursive: true }); } catch { return; }
  const hashName = `${MARKER_PREFIX}${sessionHash(sessionId)}`;
  const rawName = typeof sessionId === 'string' && sessionId.length > 0
    && !sessionId.includes('/') && !sessionId.includes('\\') && !sessionId.includes('\0')
    ? `${MARKER_PREFIX}${sessionId}` : null;
  const direct = [
    join(flatDir, hashName), join(legacyDir, hashName),
    ...(rawName ? [join(legacyDir, rawName)] : []),
  ];
  for (const source of direct) {
    const name = basename(source);
    const targetName = name === rawName ? hashName : name;
    try {
      const sourceStat = pathIdentity(source);
      if (sourceStat?.isFile) migrateLegacyFile(source, join(markerDir, targetName), sourceStat);
      else if (sourceStat?.isDirectory && name.startsWith('.cah-marker-claim-')) {
        migrateLegacyClaim(source, join(markerDir, name));
      }
    } catch { /* best effort */ }
  }

  // The compatibility sweep runs once per namespace and is bounded. Future
  // hooks only inspect the owned namespace, so unrelated cache entries never
  // become routine hook work.
  const sentinel = join(markerDir, '.migration-v1');
  if (pathIdentity(sentinel)) return;
  streamDirectoryEntries(flatDir, MIGRATION_SCAN_CAP, (entry) => {
    const name = entry.name;
    const suffix = name.startsWith(MARKER_PREFIX) ? name.slice(MARKER_PREFIX.length) : null;
    const claimPrefix = `.cah-marker-claim-${MARKER_PREFIX}`;
    const claimSuffix = name.startsWith(claimPrefix) ? name.slice(claimPrefix.length) : null;
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
    const suffix = name.startsWith(MARKER_PREFIX) ? name.slice(MARKER_PREFIX.length) : null;
    if (suffix !== null && /^[a-f0-9]{64}$/.test(suffix) && entry.isFile()) {
      const source = join(legacyDir, name);
      const stat = pathIdentity(source);
      if (stat?.isFile) migrateLegacyFile(source, join(markerDir, name), stat);
    }
  });
  try { writeFileSync(sentinel, 'v1\n', { flag: 'wx' }); } catch { /* another hook won */ }
}

function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function claimOwner(nowMs) {
  const token = randomUUID();
  return { pid: process.pid, token, nonce: token, timestamp: nowMs, claimedAt: nowMs };
}

function acquireMarkerClaim(marker, nowMs) {
  const claimPath = join(dirname(marker), `.cah-marker-claim-${basename(marker)}`);
  const lease = acquireLease(claimPath, {
    nowMs,
    staleAfterMs: MARKER_CLAIM_TTL_MS,
    fenceSuffix: '.taken-',
    interlockPhase: 'claim-reclaim',
    releaseInterlockPhase: 'claim-release',
    testLeaseEnv: 'CAH_HINT_OWNER_MAX_LEASE_MS',
  });
  return lease ? { marker, claimPath, owner: lease.owner, lease } : null;
}

function acquireMarkerCapacityLease(markerDir, nowMs) {
  return acquireLease(join(markerDir, '.cah-marker-capacity-hint'), {
    nowMs,
    staleAfterMs: MARKER_CLAIM_TTL_MS,
    fenceSuffix: '.taken-',
    interlockPhase: 'marker-capacity-lease-reclaim',
    releaseInterlockPhase: 'marker-capacity-lease-release',
    testLeaseEnv: 'CAH_HINT_OWNER_MAX_LEASE_MS',
  });
}

function markerClaimOwned(claim) {
  return Boolean(claim?.lease && leaseOwned(claim.lease));
}

function releaseMarkerClaim(claim) {
  if (!claim?.lease) return;
  const capacityLease = claim.capacityLease;
  claim.capacityLease = null;
  try {
    releaseLease(claim.lease);
  } finally {
    if (capacityLease) releaseLease(capacityLease);
  }
}

function markDelivered(claim) {
  if (!markerClaimOwned(claim)) return false;
  if (process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-durable'
        || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-marker'
        || process.env.CAH_TEST_ONLY_MARKER_WRITE_FAILURE === 'crash')) {
    process.exit(91);
  }
  try {
    const expectedDestination = captureRegularFileSnapshot(claim.marker).expectedDestination;
    if (expectedDestination.exists && !isOlderThan(expectedDestination.identity, Date.now(), MARKER_TTL_MS)) return false;
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_MARKER_WRITE_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_MARKER_STATE_WRITE_FAILURE === '1')) return false;
    writeFileAtomic(
      claim.marker,
      JSON.stringify({ nonce: claim.owner.nonce, deliveredAt: Date.now() }) + '\n',
      { expectedDestination },
    );
    return true;
  } catch { return false; }
}

// The marker is durable delivered state. A separate nonce-owned claim gates
// the write and can be recovered after a process dies before delivery.
function claimMarker(markerDir, sessionId, nowMs) {
  const marker = join(markerDir, `${MARKER_PREFIX}${sessionHash(sessionId)}`);
  try {
    mkdirSync(markerDir, { recursive: true });
    try {
      const markerStat = pathIdentity(marker);
      if (markerStat && !markerStat.isFile) return null;
      if (markerStat && !isOlderThan(markerStat, nowMs, MARKER_TTL_MS)) return null;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return null;
    }
    const claim = acquireMarkerClaim(marker, nowMs);
    if (!claim) return null;
    try {
      const capacityLease = acquireMarkerCapacityLease(markerDir, nowMs);
      if (!capacityLease) {
        releaseMarkerClaim(claim);
        return null;
      }
      claim.capacityLease = capacityLease;
      try {
        const markerStat = pathIdentity(marker);
        if (markerStat && !markerStat.isFile) {
          releaseMarkerClaim(claim);
          return null;
        }
        if (markerStat && !isOlderThan(markerStat, nowMs, MARKER_TTL_MS)) {
          releaseMarkerClaim(claim);
          return null;
        }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          releaseMarkerClaim(claim);
          return null;
        }
      }
      return claim;
    } catch {
      releaseMarkerClaim(claim);
      return null;
    }
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
    return;
  }

  // Loop guard: don't react to our own continuation.
  if (payload.stop_hook_active === true) return;

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) return;

  const home = process.env.CAH_HINT_HOME || homedir();
  const markerDir = markerNamespace(home);
  migrateLegacyMarkers(home, markerDir, sessionId);
  const protectedMarker = process.env.CAH_TEST_ONLY === '1'
    && process.env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE === 'marker-remove'
    ? null : join(markerDir, `${MARKER_PREFIX}${sessionHash(sessionId)}`);
  pruneStaleMarkers(markerDir, Date.now(), protectedMarker);

  let usedTokens = null;
  let modelId = null;
  try {
    const stats = readTranscriptStats(transcriptPath);
    if (!stats) return;
    ({ usedTokens, modelId } = stats);
  } catch {
    return; // transcript missing / unreadable
  }
  if (usedTokens === null) return;

  let envelopeLimit = null;
  try {
    const cw = payload.context_window;
    if (cw && typeof cw === 'object') envelopeLimit = validContextWindowSize(cw.context_window_size);
  } catch {
    // ignore malformed hook envelope
  }
  let cachedLimit = null;
  try {
    const cached = readRateLimitsCache(RATE_LIMITS_CACHE, Date.now(), sessionId);
    cachedLimit = cached && cached.contextWindowSize;
  } catch {
    // fail-silent — use the model fallback
  }
  const suppliedLimit = envelopeLimit || cachedLimit;
  // A missing model is not evidence of the 200k default. Only an explicit,
  // validated envelope/cache limit can make an anonymous transcript useful.
  const limit = modelId === null
    ? suppliedLimit
    : contextWindowLimit(modelId, suppliedLimit);
  if (!validContextWindowSize(limit)) return;
  const ratio = usedTokens / limit;
  if (ratio < THRESHOLD) return;

  // Threshold crossed: claim before emitting. A failed claim means another
  // process already owns the one-shot hint.
  const claim = claimMarker(markerDir, sessionId, Date.now());
  if (!claim) return;
  try {
    if (!markerClaimOwned(claim)) return;
    writeSync(1, MESSAGE + '\n');
    if (markDelivered(claim)) {
      reserveMarkerCapacity(markerDir, Date.now(), claim.marker);
      pruneStaleMarkers(markerDir, Date.now());
    }
  } finally {
    releaseMarkerClaim(claim);
  }
}

try {
  main();
} catch {
  // Fail-silent: a Stop hook must never break the session. Matches the other
  // companion bins (cah-stamp, cah-status, cah-status-probe).
}

process.exit(0);
