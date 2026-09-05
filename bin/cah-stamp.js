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

import { readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, openSync, closeSync, readdirSync, statSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
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
import { writeFileAtomic } from '../lib/fsutil.js';

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
// Request claims are bounded too: a process killed after persisting its
// state cannot suppress a future retry forever. Anonymous turns use a short
// fingerprint claim only to cover the handoff between concurrent hooks.

// Shared with cah-status: whichever bin runs first populates this cache, so
// the npm registry is only ever hit once per TTL window (see lib/update-check.js).
const UPDATE_CHECK_CACHE =
  process.env.CAH_UPDATE_CHECK_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');

// One marker file per session gates the one-shot "new version" notice —
// A separate nonce-owned claim gates stdout and is swept safely.
// are swept on each run so they never accumulate.
const UPDATE_MARKER_PREFIX = 'cah-update-shown-';
const UPDATE_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_MARKER_CLAIM_TTL_MS = 30_000;
const UPDATE_MARKER_MAX_SESSIONS = 64;
const UPDATE_MARKER_NAME_RE = /^cah-update-shown-[a-f0-9]{64}$/;
const STAMP_PENDING_TTL_MS = positiveEnvMs('CAH_STAMP_PENDING_TTL_MS', 30_000);
const ANONYMOUS_CLAIM_TTL_MS = 1000;

function positiveEnvMs(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pruneStaleMarkers(markerDir, nowMs) {
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
      const stat = statSync(p);
      if (nowMs - stat.mtimeMs > UPDATE_MARKER_TTL_MS) {
        const claim = acquireUpdateMarkerClaim(p, nowMs);
        if (!claim) continue;
        try {
          const current = statSync(p);
          if (nowMs - current.mtimeMs > UPDATE_MARKER_TTL_MS) removePathIfUnchanged(p, current);
        } finally {
          releaseUpdateMarkerClaim(claim);
        }
        continue;
      }
      candidates.push({ path: p, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of candidates.slice(UPDATE_MARKER_MAX_SESSIONS)) {
    try {
      const claim = acquireUpdateMarkerClaim(entry.path, nowMs);
      if (!claim) continue;
      try {
        const current = statSync(entry.path);
        if (nowMs - current.mtimeMs > UPDATE_MARKER_TTL_MS || candidates.length > UPDATE_MARKER_MAX_SESSIONS) {
          removePathIfUnchanged(entry.path, current);
        }
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
  return { pid: process.pid, nonce: randomUUID(), claimedAt: nowMs };
}

function readUpdateMarkerOwner(claimPath) {
  try {
    const claimStat = statSync(claimPath);
    const ownerPath = claimStat.isDirectory() ? join(claimPath, 'owner.json') : claimPath;
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string') return null;
    return owner;
  } catch {
    return null;
  }
}

function updateMarkerProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function fileIdentity(path) {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameFileIdentity(left, right) {
  return left !== null && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function pathIdentity(path) {
  try {
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino, isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

function samePathIdentity(left, right) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function ownerSnapshot(path, readOwner) {
  return { owner: readOwner(path), identity: fileIdentity(path) };
}

function sameOwnerSnapshot(path, expected, readOwner) {
  const actualOwner = readOwner(path);
  if (expected.owner && actualOwner) {
    return expected.owner.pid === actualOwner.pid && expected.owner.nonce === actualOwner.nonce;
  }
  return expected.owner === null && actualOwner === null
    && sameFileIdentity(expected.identity, fileIdentity(path));
}

function removeClaimPath(path) {
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isDirectory()) {
      const entries = readdirSync(path);
      if (entries.some((entry) => entry !== 'owner.json')) return false;
      if (entries.includes('owner.json')) unlinkSync(join(path, 'owner.json'));
      rmdirSync(path);
      return true;
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

function restoreMovedPath(tombstone, path) {
  const source = pathIdentity(tombstone);
  if (!source) return false;
  if (source.isDirectory) {
    let targetCreated = false;
    try {
      mkdirSync(path);
      targetCreated = true;
      const entries = readdirSync(tombstone);
      if (entries.includes('owner.json')) {
        renameSync(join(tombstone, 'owner.json'), join(path, 'owner.json'));
      } else if (entries.length !== 0) {
        rmdirSync(path);
        return false;
      }
      try { rmdirSync(tombstone); } catch { /* preserve unexpected entries */ }
      return true;
    } catch {
      if (targetCreated) {
        try { rmdirSync(path); } catch { /* a successor or extra entry won */ }
      }
      return false;
    }
  }
  let data;
  try { data = readFileSync(tombstone); } catch { return false; }
  let fd = null;
  let target = null;
  try {
    fd = openSync(path, 'wx');
    target = pathIdentity(path);
    writeSync(fd, data);
    closeSync(fd);
    fd = null;
    if (!samePathIdentity(source, pathIdentity(tombstone))) return false;
    unlinkSync(tombstone);
    return true;
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
      if (samePathIdentity(target, pathIdentity(path))) {
        try { unlinkSync(path); } catch { /* a successor may own it */ }
      }
    }
    return false;
  }
}

function testOwnerInterlock(phase, stage = 'before') {
  if (process.env.CAH_TEST_ONLY !== '1') return;
  const base = process.env.CAH_TEST_ONLY_OWNER_INTERLOCK;
  const configured = process.env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE;
  if (!base) return;
  const staged = configured === `${phase}-three-party`;
  if ((!staged && (configured !== phase || stage !== 'before'))) return;
  const stageBase = staged ? `${base}.${stage}` : base;
  try { writeFileSync(`${stageBase}.ready`, `${phase}:${stage}`, { flag: 'wx' }); } catch { return; }
  const deadline = Date.now() + 10_000;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try { statSync(`${stageBase}.go`); return; } catch { /* keep waiting */ }
    Atomics.wait(waitArray, 0, 0, 10);
  }
}

function takeOwnerPath(path, expected, readOwner, phase) {
  testOwnerInterlock(phase, 'before');
  const tombstone = `${path}.taken-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, tombstone);
  } catch {
    return null;
  }
  testOwnerInterlock(phase, 'vacancy');
  if (sameOwnerSnapshot(tombstone, expected, readOwner)) return tombstone;
  restoreMovedPath(tombstone, path);
  return null;
}

function fencePaths(path) {
  const prefix = `${basename(path)}.taken-`;
  try {
    return readdirSync(dirname(path))
      .filter((name) => name.startsWith(prefix)
        && /^\d+-[^/]+$/.test(name.slice(prefix.length)))
      .map((name) => join(dirname(path), name));
  } catch {
    return [];
  }
}

function fenceOperatorPid(path, fencePath) {
  const prefix = `${basename(path)}.taken-`;
  const suffix = basename(fencePath).slice(prefix.length);
  const match = /^(\d+)-/.exec(suffix);
  return match ? Number.parseInt(match[1], 10) : null;
}

function quarantineUnexpectedFence(fencePath) {
  try {
    if (!lstatSync(fencePath).isDirectory()) return false;
    const entries = readdirSync(fencePath);
    if (!entries.some((entry) => entry !== 'owner.json')) return false;
    renameSync(fencePath, `${fencePath}.orphan-${process.pid}-${randomUUID()}`);
    return true;
  } catch {
    return false;
  }
}

function recoverAbandonedFence(path, fencePath, readOwner, pidIsAlive) {
  const operatorPid = fenceOperatorPid(path, fencePath);
  if (!Number.isInteger(operatorPid) || operatorPid <= 0 || pidIsAlive(operatorPid)) return false;
  const fencedIdentity = fileIdentity(fencePath);
  if (!fencedIdentity) return true;
  if (quarantineUnexpectedFence(fencePath)) return true;
  const currentIdentity = fileIdentity(path);
  if (currentIdentity && sameFileIdentity(fencedIdentity, currentIdentity)) {
    return removeClaimPath(fencePath);
  }
  if (currentIdentity) {
    const currentOwner = readOwner(path);
    if (!currentOwner) {
      let entries;
      try {
        if (!lstatSync(path).isDirectory()) return false;
        entries = readdirSync(path);
      } catch {
        return false;
      }
      if (entries.length !== 0) return false;
    } else if (pidIsAlive(currentOwner.pid)) return false;
    const currentSnapshot = ownerSnapshot(path, readOwner);
    const quarantine = `${path}.abandoned-${process.pid}-${randomUUID()}`;
    try { renameSync(path, quarantine); } catch { return false; }
    if (!sameOwnerSnapshot(quarantine, currentSnapshot, readOwner)) {
      restoreMovedPath(quarantine, path);
      return false;
    }
    if (!removeClaimPath(quarantine)) return false;
  }
  return restoreMovedPath(fencePath, path);
}

function hasInFlightFence(path, readOwner, pidIsAlive) {
  for (const fencePath of fencePaths(path)) {
    if (!recoverAbandonedFence(path, fencePath, readOwner, pidIsAlive)) return true;
  }
  return fencePaths(path).length > 0;
}

function rollbackOwnedPath(path, owner, readOwner) {
  const expected = ownerSnapshot(path, readOwner);
  if (!expected.owner
    || expected.owner.pid !== owner.pid
    || expected.owner.nonce !== owner.nonce) return;
  const tombstone = takeOwnerPath(path, expected, readOwner, 'owner-rollback');
  if (!tombstone) return;
  removeClaimPath(tombstone);
}

function cleanupCreatedClaim(path, identity) {
  const current = pathIdentity(path);
  if (!identity || !current || !current.isDirectory || !samePathIdentity(identity, current)) return false;
  return removeClaimPath(path);
}

function removePathIfUnchanged(path, expectedIdentity, phase = 'marker-remove') {
  testOwnerInterlock(phase);
  const tombstone = `${path}.prune-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, tombstone);
  } catch {
    return false;
  }
  if (!sameFileIdentity(expectedIdentity, fileIdentity(tombstone))) {
    restoreMovedPath(tombstone, path);
    return false;
  }
  try { unlinkSync(tombstone); } catch { return false; }
  return true;
}

function updateMarkerClaimExpired(snapshot, nowMs) {
  if (!snapshot.identity) return false;
  if (snapshot.owner) return !updateMarkerProcessIsAlive(snapshot.owner.pid);
  return nowMs - snapshot.identity.mtimeMs > UPDATE_MARKER_CLAIM_TTL_MS;
}

function acquireUpdateMarkerClaim(marker, nowMs) {
  const claimPath = join(dirname(marker), `.cah-marker-claim-${basename(marker)}`);
  const owner = updateMarkerOwner(nowMs);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (hasInFlightFence(claimPath, readUpdateMarkerOwner, updateMarkerProcessIsAlive)) return null;
    let createdIdentity = null;
    try {
      // mkdir is the portable atomic ownership operation. Metadata is
      // written inside the directory only after mkdir has won the race.
      mkdirSync(claimPath);
      createdIdentity = pathIdentity(claimPath);
      testOwnerInterlock('owner-write');
      writeFileSync(join(claimPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      if (hasInFlightFence(claimPath, readUpdateMarkerOwner, updateMarkerProcessIsAlive)) {
        rollbackOwnedPath(claimPath, owner, readUpdateMarkerOwner);
        return null;
      }
      return { marker, claimPath, owner };
    } catch (error) {
      if (createdIdentity) {
        cleanupCreatedClaim(claimPath, createdIdentity);
        return null;
      }
      if (!error || error.code !== 'EEXIST') return null;
      if (hasInFlightFence(claimPath, readUpdateMarkerOwner, updateMarkerProcessIsAlive)) return null;
      const expected = ownerSnapshot(claimPath, readUpdateMarkerOwner);
      if (!updateMarkerClaimExpired(expected, nowMs)) return null;
      const tombstone = takeOwnerPath(claimPath, expected, readUpdateMarkerOwner, 'claim-reclaim');
      if (!tombstone) continue;
      if (!removeClaimPath(tombstone)) return null;
    }
  }
  return null;
}

function updateMarkerClaimOwned(claim) {
  if (!claim) return false;
  const owner = readUpdateMarkerOwner(claim.claimPath);
  return owner !== null && owner.pid === claim.owner.pid && owner.nonce === claim.owner.nonce;
}

function releaseUpdateMarkerClaim(claim) {
  const expected = {
    owner: claim && claim.owner,
    identity: fileIdentity(claim && claim.claimPath),
  };
  if (!claim || !expected.owner || !updateMarkerClaimOwned(claim)) return;
  const tombstone = takeOwnerPath(claim.claimPath, expected, readUpdateMarkerOwner, 'claim-release');
  if (!tombstone) return;
  removeClaimPath(tombstone);
}

function markUpdateDelivered(claim) {
  if (!updateMarkerClaimOwned(claim)) return false;
  try {
    const fd = openSync(claim.marker, 'wx');
    try {
      writeSync(fd, JSON.stringify({ nonce: claim.owner.nonce, deliveredAt: Date.now() }));
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
      const markerStat = statSync(marker);
      if (nowMs - markerStat.mtimeMs <= UPDATE_MARKER_TTL_MS) return null;
    } catch (statError) {
      if (!statError || statError.code !== 'ENOENT') return null;
    }
    const claim = acquireUpdateMarkerClaim(marker, nowMs);
    if (!claim) return null;
    try {
      try {
        const markerStat = statSync(marker);
        if (nowMs - markerStat.mtimeMs <= UPDATE_MARKER_TTL_MS) {
          releaseUpdateMarkerClaim(claim);
          return null;
        }
        if (!removePathIfUnchanged(marker, markerStat)) {
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
  const markerDir = join(home, '.claude');
  pruneStaleMarkers(markerDir, nowMs);

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
    const notice = {
      claim,
      text: `\nðŸ”µ cc-arch-hands v${latest} is out (you're on v${CURRENT_VERSION}). Update:\n` +
        '  global: npm install -g cc-arch-hands@latest && npx cah reinstall\n' +
        '  local:  npm install cc-arch-hands@latest && npx cah reinstall --local',
    };
    notice.text = notice.text.replace(/^\n[^ ]+ cc-arch-hands/, `\n${String.fromCodePoint(0x1F535)} cc-arch-hands`);
    return notice;
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
      const stat = statSync(sidecar);
      if (nowMs - stat.mtimeMs > STAMP_STATE_TTL_MS) {
        removePathIfUnchanged(sidecar, stat, 'sidecar-prune');
        continue;
      }
      candidates.push({ path: sidecar, mtimeMs: stat.mtimeMs });
    } catch {
      // Best-effort cleanup; concurrent hook processes may be writing it.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of candidates.slice(MAX_STAMP_SESSIONS)) {
    try {
      const current = statSync(entry.path);
      removePathIfUnchanged(entry.path, current, 'sidecar-prune');
    } catch { /* best effort */ }
  }
}

function writeLastStamp(path, sessionId, ts, requestId, fingerprint, deliveryState) {
  const sidecar = sessionStatePath(path, sessionId);
  try {
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
  return { pid: process.pid, nonce: randomUUID(), startedAt: nowMs };
}

function readStampLockOwner(lockPath) {
  try {
    const lockStat = statSync(lockPath);
    const ownerPath = lockStat.isDirectory() ? join(lockPath, 'owner.json') : lockPath;
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string') return null;
    return owner;
  } catch {
    return null;
  }
}

function stampLockOwnerIsAlive(owner) {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM and unknown errors mean the owner is considered alive.
    return !(error && error.code === 'ESRCH');
  }
}

function stampLockClaimExpired(snapshot, nowMs) {
  if (!snapshot.identity) return false;
  if (snapshot.owner) return !stampLockOwnerIsAlive(snapshot.owner);
  return nowMs - snapshot.identity.mtimeMs > STAMP_LOCK_CLAIM_TTL_MS;
}

function acquireStampLock(path, sessionId, nowMs) {
  const lockPath = stampLockPath(path, sessionId);
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { return null; }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (hasInFlightFence(lockPath, readStampLockOwner, updateMarkerProcessIsAlive)) return null;
    const owner = stampLockOwner(nowMs);
    let createdIdentity = null;
    try {
      // mkdir is the portable atomic lock acquisition primitive. The owner
      // record is published inside the directory after it wins the race.
      mkdirSync(lockPath);
      createdIdentity = pathIdentity(lockPath);
      testOwnerInterlock('owner-write');
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      if (hasInFlightFence(lockPath, readStampLockOwner, updateMarkerProcessIsAlive)) {
        rollbackOwnedPath(lockPath, owner, readStampLockOwner);
        return null;
      }
      return { path: lockPath, owner };
    } catch (error) {
      if (createdIdentity) {
        cleanupCreatedClaim(lockPath, createdIdentity);
        return null;
      }
      if (!error || error.code !== 'EEXIST') return null;
      if (hasInFlightFence(lockPath, readStampLockOwner, updateMarkerProcessIsAlive)) return null;
      const expected = ownerSnapshot(lockPath, readStampLockOwner);
      if (!stampLockClaimExpired(expected, nowMs)) return null;
      const tombstone = takeOwnerPath(lockPath, expected, readStampLockOwner, 'lock-reclaim');
      if (!tombstone) continue;
      if (!removeClaimPath(tombstone)) return null;
    }
  }
  return null;
}

function releaseStampLock(lock) {
  if (!lock || !lock.path || !lock.owner) return;
  const expected = ownerSnapshot(lock.path, readStampLockOwner);
  if (!expected.owner
    || expected.owner.pid !== lock.owner.pid
    || expected.owner.nonce !== lock.owner.nonce) return;
  const tombstone = takeOwnerPath(lock.path, expected, readStampLockOwner, 'lock-release');
  if (!tombstone) return;
  removeClaimPath(tombstone);
}

function transcriptFingerprint(path) {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
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
  const lockPath = acquireStampLock(STAMP_THROTTLE_PATH, payload.session_id, nowMs);
  if (!lockPath) return;
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
    releaseStampLock(lockPath);
  }
}

try {
  main();
} catch {
  /* fail silent */
}

process.exit(0);
