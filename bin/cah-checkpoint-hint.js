#!/usr/bin/env node
// cah-checkpoint-hint — Claude Code Stop hook.
//
// Reads the hook JSON payload from stdin, inspects the session transcript,
// and emits ONE soft systemMessage suggesting /checkpoint when context usage
// crosses 90% of the model's limit. It is deliberately fail-silent: any error,
// missing input, or filesystem hiccup results in `exit 0` with no stdout, so it
// can never break the user's session.

import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, lstatSync, unlinkSync, writeSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readTranscriptStats, contextWindowLimit, readRateLimitsCache, validContextWindowSize } from '../lib/transcript-stats.js';
import {
  acquireLease, leaseOwned, pathIdentity, releaseLease, removePathIfUnchanged, samePathIdentity,
} from '../lib/lease-lock.js';

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
const LEGACY_MARKER_PREFIXES = ['cah-hint-shown-', 'cah-update-shown-'];
const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

function pruneStaleMarkers(markerDir, nowMs) {
  let entries;
  try {
    entries = readdirSync(markerDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!MARKER_NAME_RE.test(name)) continue;
    const p = join(markerDir, name);
    try {
      if (nowMs - statSync(p).mtimeMs > MARKER_TTL_MS) {
        const claim = acquireMarkerClaim(p, nowMs);
        if (!claim) continue;
        try {
          const current = statSync(p);
          if (nowMs - current.mtimeMs > MARKER_TTL_MS) {
            removePathIfUnchanged(p, current, 'marker-remove');
          }
        } finally {
          releaseMarkerClaim(claim);
        }
      }
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  }
  const fresh = [];
  for (const name of entries) {
    if (!MARKER_NAME_RE.test(name)) continue;
    const p = join(markerDir, name);
    try { fresh.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } catch { /* best effort */ }
  }
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of fresh.slice(MARKER_MAX_SESSIONS)) {
    try {
      const claim = acquireMarkerClaim(entry.path, nowMs);
      if (!claim) continue;
      try {
        const current = statSync(entry.path);
        removePathIfUnchanged(entry.path, current, 'marker-remove');
      } finally {
        releaseMarkerClaim(claim);
      }
    } catch { /* best effort */ }
  }
}

function directLegacyMarkerPrefix(name) {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return LEGACY_MARKER_PREFIXES.find((prefix) => name.startsWith(prefix) && name.length > prefix.length) || null;
}

function sameLegacyFileIdentity(left, right) {
  return left !== null && right !== null
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function removeLegacyIfUnchanged(path, expected) {
  try {
    const current = lstatSync(path);
    if (!current.isFile() || !sameLegacyFileIdentity(expected, current)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function migrateLegacyFile(source, target, sourceStat) {
  try {
    const targetStat = lstatSync(target);
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

function migrateLegacyMarkers(home, markerDir, sessionId, nowMs = Date.now()) {
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
      sourceStat = lstatSync(source);
      if (!sourceStat.isFile()) continue;
    } catch {
      continue;
    }

    // Raw legacy names cannot be mapped for another session. Retain fresh
    // ones for a later exact match, but sweep stale entries regardless of
    // whether their suffix is a hash, UUID, or any other old session ID.
    if (nowMs - sourceStat.mtimeMs > MARKER_TTL_MS) {
      removeLegacyIfUnchanged(source, sourceStat);
      continue;
    }

    const currentName = typeof sessionId === 'string' ? `${prefix}${sessionId}` : null;
    const isCurrentSession = currentName !== null && currentName === name;
    const suffix = name.slice(prefix.length);
    const isLegacyHash = /^[a-f0-9]{64}$/.test(suffix);
    if (!isCurrentSession && !isLegacyHash) continue;

    const targetName = isCurrentSession
      ? `${prefix}${sessionHash(sessionId)}`
      : name;
    migrateLegacyFile(source, join(markerDir, targetName), sourceStat);
  }
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

function markerClaimOwned(claim) {
  return Boolean(claim?.lease && leaseOwned(claim.lease));
}

function releaseMarkerClaim(claim) {
  if (claim?.lease) releaseLease(claim.lease);
}

function markDelivered(claim) {
  if (!markerClaimOwned(claim)) return false;
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

// The marker is durable delivered state. A separate nonce-owned claim gates
// the write and can be recovered after a process dies before delivery.
function claimMarker(markerDir, sessionId, nowMs) {
  const marker = join(markerDir, `${MARKER_PREFIX}${sessionHash(sessionId)}`);
  try {
    mkdirSync(markerDir, { recursive: true });
    try {
      const markerStat = statSync(marker);
      if (nowMs - markerStat.mtimeMs <= MARKER_TTL_MS) return null;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return null;
    }
    const claim = acquireMarkerClaim(marker, nowMs);
    if (!claim) return null;
    try {
      try {
        const markerStat = statSync(marker);
        if (nowMs - markerStat.mtimeMs <= MARKER_TTL_MS) {
          releaseMarkerClaim(claim);
          return null;
        }
        if (!removePathIfUnchanged(marker, markerStat, 'marker-remove')) {
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
  const markerDir = join(home, '.claude', 'cah-bin', 'cache');
  migrateLegacyMarkers(home, markerDir, sessionId);
  pruneStaleMarkers(markerDir, Date.now());

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
    markDelivered(claim);
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
