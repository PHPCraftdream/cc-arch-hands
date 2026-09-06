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

import { readFileSync, writeFileSync, writeSync, mkdirSync, openSync, closeSync, readdirSync, statSync, lstatSync, unlinkSync } from 'node:fs';
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
  acquireLease, leaseOwned, pathIdentity, releaseLease, removePathIfUnchanged, samePathIdentity,
} from '../lib/lease-lock.js';

// Pro/Max rate_limits are only in the statusLine envelope; cah-status
// persists them here so we can include them in the chat audit trail.
// CAH_RATE_LIMITS_CACHE env override lets tests/CI redirect the read path.
const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

// Throttle state for the chat audit-trail. The primary dedup is per-message
// via requestId (every assistant entry of the same turn shares it), so this
// time-throttle is a safety net only. Default 10s — short enough to never
// suppress the next real turn, long enough to ignore odd hook bursts.
const STAMP_THROTTLE_PATH =
  process.env.CAH_STAMP_THROTTLE_PATH ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'last-stamp.json');
const STAMP_MIN_INTERVAL_MS =
  parseInt(process.env.CAH_STAMP_MIN_INTERVAL_MS || '', 10) || 10_000;
const MAX_STAMP_SESSIONS = 64;
const MAX_FINGERPRINT_LENGTH = 512;
const FALLBACK_SESSION_KEY = '__no_session__';
const STAMP_STATE_PREFIX = '.session-';
const STAMP_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP_LOCK_CLAIM_TTL_MS = 30_000;
// Normal lock ownership lasts milliseconds. Fifteen minutes is a conservative
// absolute lease that bounds PID reuse without stealing a live hook.
// Request claims are bounded too: a process killed after persisting its
// state cannot suppress a future retry forever. Anonymous turns use a short
// fingerprint claim only to cover the handoff between concurrent hooks.

// Shared with cah-status: whichever bin runs first populates this cache, so
// the npm registry is only ever hit once per TTL window (see lib/update-check.js).
const UPDATE_CHECK_CACHE =
  process.env.CAH_UPDATE_CHECK_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');

// One marker file per session gates the one-shot "new version" notice.
// A separate nonce-owned claim gates stdout, and stale markers are swept on
// each run so they never accumulate.
const UPDATE_MARKER_PREFIX = 'cah-update-shown-';
const UPDATE_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_MARKER_CLAIM_TTL_MS = 30_000;
const UPDATE_MARKER_MAX_SESSIONS = 64;
const UPDATE_MARKER_NAME_RE = /^cah-update-shown-[a-f0-9]{64}$/;
const LEGACY_MARKER_PREFIXES = ['cah-hint-shown-', 'cah-update-shown-'];
const STAMP_PENDING_TTL_MS = positiveEnvMs('CAH_STAMP_PENDING_TTL_MS', 30_000);
const ANONYMOUS_CLAIM_TTL_MS = 1000;

function positiveEnvMs(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function directLegacyMarkerPrefix(name) {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return LEGACY_MARKER_PREFIXES.find((prefix) => name.startsWith(prefix) && name.length > prefix.length) || null;
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

function migrateLegacyMarkers(home, markerDir, sessionId) {
  const legacyDir = join(home, '.claude');
  if (legacyDir === markerDir) return;
  let entries;
  try {
    entries = readdirSync(legacyDir);
    mkdirSync(markerDir, { recursive: true });
  } catch {
    return;
  }
  for (const name of entries) {
    const prefix = directLegacyMarkerPrefix(name);
    if (!prefix) continue;
    const source = join(legacyDir, name);
    let sourceStat;
    try {
      sourceStat = pathIdentity(source);
      if (!sourceStat?.isFile) continue;
    } catch {
      continue;
    }

    const isCurrentSession = isSafeCurrentMarkerName(name, prefix, sessionId);
    const suffix = name.slice(prefix.length);
    const isLegacyHash = /^[a-f0-9]{64}$/.test(suffix);
    if (!isCurrentSession && !isLegacyHash) continue;

    const targetName = isCurrentSession
      ? `${prefix}${sessionHash(sessionId)}`
      : name;
    migrateLegacyFile(source, join(markerDir, targetName), sourceStat);
  }
}

function pruneStaleMarkers(markerDir, nowMs, protectedMarker = null) {
  let entries;
  try {
    entries = readdirSync(markerDir);
  } catch {
    return;
  }
  const candidates = [];
  for (const name of entries) {
    if (!UPDATE_MARKER_NAME_RE.test(name)) continue;
    const p = join(markerDir, name);
    try {
      const stat = pathIdentity(p);
      if (!stat?.isFile) continue;
      if (isOlderThan(stat, nowMs, UPDATE_MARKER_TTL_MS)) {
        const claim = acquireUpdateMarkerClaim(p, nowMs);
        if (!claim) continue;
        try {
          const current = pathIdentity(p);
          if (current?.isFile && isOlderThan(current, nowMs, UPDATE_MARKER_TTL_MS)) {
            removePathIfUnchanged(p, current, 'marker-remove');
          }
        } finally {
          releaseUpdateMarkerClaim(claim);
        }
        continue;
      }
      candidates.push({ path: p, identity: stat, mtimeNs: stat.mtimeNs });
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  }
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  // Leave one slot for the session that is about to claim a marker.
  const capacity = candidates.filter((entry) => entry.path !== protectedMarker);
  for (const entry of capacity.slice(Math.max(0, UPDATE_MARKER_MAX_SESSIONS - 1))) {
    try {
      const claim = acquireUpdateMarkerClaim(entry.path, nowMs);
      if (!claim) continue;
      try {
        removePathIfUnchanged(entry.path, entry.identity, 'marker-capacity');
      } finally {
        releaseUpdateMarkerClaim(claim);
      }
    } catch { /* best effort */ }
  }
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

function updateMarkerClaimOwned(claim) {
  return Boolean(claim?.lease && leaseOwned(claim.lease));
}

function releaseUpdateMarkerClaim(claim) {
  if (claim?.lease) releaseLease(claim.lease);
}

function markUpdateDelivered(claim) {
  if (!updateMarkerClaimOwned(claim)) return false;
  try {
    const fd = openSync(claim.marker, 'wx');
    try {
      writeSync(fd, JSON.stringify({ nonce: claim.owner.nonce || claim.owner.token, deliveredAt: Date.now() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EEXIST');
  }
}

function claimUpdateMarker(markerDir, sessionId, nowMs) {
  const marker = join(markerDir, `${UPDATE_MARKER_PREFIX}${sessionHash(sessionId)}`);
  try {
    mkdirSync(markerDir, { recursive: true });
    try {
      const markerStat = pathIdentity(marker);
      if (markerStat && !markerStat.isFile) return null;
      if (markerStat && !isOlderThan(markerStat, nowMs, UPDATE_MARKER_TTL_MS)) return null;
    } catch (statError) {
      if (!statError || statError.code !== 'ENOENT') return null;
    }
    const claim = acquireUpdateMarkerClaim(marker, nowMs);
    if (!claim) return null;
    try {
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
        if (markerStat && !removePathIfUnchanged(marker, markerStat, 'marker-remove')) {
          releaseUpdateMarkerClaim(claim);
          return null;
        }
      } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== 'ENOENT') {
          releaseUpdateMarkerClaim(claim);
          return null;
        }
      }
      return claim;
    } catch {
      releaseUpdateMarkerClaim(claim);
      return null;
    }
  } catch {
    return null;
  }
}

// Builds the one-shot "new version available" notice, or '' if none is due:
// only on a real Stop event (never PostToolUse, which fires per tool call),
// only once per session, and only when the cached registry check found a
// newer version than CURRENT_VERSION.
function buildUpdateNotice(payload, nowMs) {
  if (payload.hook_event_name !== 'Stop') return null;
  const sessionId = payload.session_id;
  if (!sessionId) return null;

  const home = process.env.CAH_STAMP_HINT_HOME || homedir();
  const markerDir = join(home, '.claude', 'cah-bin', 'cache');
  migrateLegacyMarkers(home, markerDir, sessionId);
  pruneStaleMarkers(
    markerDir, nowMs, join(markerDir, `${UPDATE_MARKER_PREFIX}${sessionHash(sessionId)}`),
  );

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
  // Pre-v3 sidecars stored requestId text. Accept exact legacy values, but
  // never treat a 512-character prefix as a match for a longer full ID.
  return last.requestId === normalized;
}

function sessionStatePath(path, sessionId) {
  return `${path}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`;
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
    // Fall through to the pre-sidecar state for one-way compatibility.
  }
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (obj && typeof obj.sessions === 'object' && obj.sessions !== null) {
      return stampRecord(obj.sessions[sessionKey(sessionId)]);
    }
    // Compatibility fallback for the pre-session-partition flat state.
    return stampRecord(obj);
  } catch {
    return { ts: null, requestId: null, fingerprint: null, deliveryState: 'delivered' };
  }
}

function pruneStampSidecars(path, nowMs) {
  let names;
  try {
    names = readdirSync(dirname(path));
  } catch {
    return;
  }
  const prefix = basename(path) + STAMP_STATE_PREFIX;
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const sidecar = join(dirname(path), name);
    try {
      const lstat = lstatSync(sidecar, { bigint: true });
      if (!lstat.isFile() || lstat.nlink !== 1n) continue;
      const stat = pathIdentity(sidecar);
      if (isOlderThan(stat, nowMs, STAMP_STATE_TTL_MS)) {
        removePathIfUnchanged(sidecar, stat, 'sidecar-prune');
        continue;
      }
      // Keep the complete scan-time identity, including the content digest.
      // Capacity removal must act on this exact observation; rescanning the
      // path after the interlock could turn a successor into the file we
      // remove.
      candidates.push({ path: sidecar, identity: stat, mtimeNs: stat.mtimeNs });
    } catch {
      // Best-effort cleanup; concurrent hook processes may be writing it.
    }
  }
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  for (const entry of candidates.slice(MAX_STAMP_SESSIONS)) {
    try {
      removePathIfUnchanged(entry.path, entry.identity, 'sidecar-prune-capacity');
    } catch { /* best effort */ }
  }
}

function writeLastStamp(path, sessionId, ts, requestId, fingerprint, deliveryState) {
  const sidecar = sessionStatePath(path, sessionId);
  try {
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

  // Loop guard: don't stamp during agent-continue loops.
  if (payload.stop_hook_active === true) return;

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) return;

  // Compute the notice before deciding whether the stamp itself is suppressed.
  // A Stop can be the second hook for a turn already stamped by PostToolUse;
  // in that case the notice must be delivered without replaying the stamp.
  const nowMs = Date.now();
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

  // HH:MM:SS so cadence bugs (e.g. throttle not honoured, dual-hook spam)
  // are diagnosable from the chat scrollback alone.
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

  // Per-message dedup: every assistant entry of the same turn shares the same
  // requestId (text + each tool_use block). If either this or the time guard
  // suppresses the stamp, a due update notice is the only allowed output.
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
          markUpdateDelivered(updateNotice.claim);
          pruneStaleMarkers(dirname(updateNotice.claim.marker), Date.now());
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

  // If we have usedTokens but no modelId, we cannot compute a meaningful
  // percentage without knowing the limit, so degrade to HH:MM.
  // If we have modelId but no usedTokens, use model name without usage %.
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

  // Effort is deliberately omitted here: Claude Code only ever exposes
  // effort.level in the statusLine envelope, never in the Stop/PostToolUse
  // hook payload or the transcript. Echoing the cached statusLine value into
  // the chat stamp can show the previous turn's effort for one turn after a
  // model/effort switch — better to omit it than show a value that isn't
  // reliably tied to the turn being stamped.
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
  // Mark delivered only after the small hook response reaches stdout
  // synchronously. A write failure leaves the short-lived pending claim.
  writeSync(1, out + '\n');
  if (updateNotice) {
    markUpdateDelivered(updateNotice.claim);
    pruneStaleMarkers(dirname(updateNotice.claim.marker), Date.now());
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
    if (updateNotice) releaseUpdateMarkerClaim(updateNotice.claim);
    releaseStampLock(stampLock);
  }
}

try {
  main();
} catch {
  /* fail silent */
}

process.exit(0);
