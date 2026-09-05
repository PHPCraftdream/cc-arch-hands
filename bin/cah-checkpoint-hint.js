#!/usr/bin/env node
// cah-checkpoint-hint — Claude Code Stop hook.
//
// Reads the hook JSON payload from stdin, inspects the session transcript,
// and emits ONE soft systemMessage suggesting /checkpoint when context usage
// crosses 90% of the model's limit. It is deliberately fail-silent: any error,
// missing input, or filesystem hiccup results in `exit 0` with no stdout, so it
// can never break the user's session.

import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, lstatSync, unlinkSync, renameSync, rmdirSync, writeSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readTranscriptStats, contextWindowLimit, readRateLimitsCache, validContextWindowSize } from '../lib/transcript-stats.js';

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
          if (nowMs - current.mtimeMs > MARKER_TTL_MS) removePathIfUnchanged(p, current);
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
        if (nowMs - current.mtimeMs > MARKER_TTL_MS || fresh.length > MARKER_MAX_SESSIONS) {
          removePathIfUnchanged(entry.path, current);
        }
      } finally {
        releaseMarkerClaim(claim);
      }
    } catch { /* best effort */ }
  }
}

function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function claimOwner(nowMs) {
  return { pid: process.pid, nonce: randomUUID(), claimedAt: nowMs };
}

function readClaimOwner(claimPath) {
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

function processIsAlive(pid) {
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

function ownerSnapshot(path) {
  return { owner: readClaimOwner(path), identity: fileIdentity(path) };
}

function sameOwnerSnapshot(path, expected) {
  const actualOwner = readClaimOwner(path);
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
    // Preserve the moved inode under its tombstone rather than deleting a
    // successor when another owner already occupies the canonical path.
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

function takeOwnerPath(path, expected, phase) {
  testOwnerInterlock(phase, 'before');
  const tombstone = `${path}.taken-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, tombstone);
  } catch {
    return null;
  }
  testOwnerInterlock(phase, 'vacancy');
  if (sameOwnerSnapshot(tombstone, expected)) return tombstone;
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

function recoverAbandonedFence(path, fencePath) {
  const operatorPid = fenceOperatorPid(path, fencePath);
  if (!Number.isInteger(operatorPid) || operatorPid <= 0 || processIsAlive(operatorPid)) return false;
  const fencedIdentity = fileIdentity(fencePath);
  if (!fencedIdentity) return true;
  if (quarantineUnexpectedFence(fencePath)) return true;
  const currentIdentity = fileIdentity(path);
  if (currentIdentity && sameFileIdentity(fencedIdentity, currentIdentity)) {
    return removeClaimPath(fencePath);
  }
  if (currentIdentity) {
    const currentOwner = readClaimOwner(path);
    if (!currentOwner) {
      let entries;
      try {
        if (!lstatSync(path).isDirectory()) return false;
        entries = readdirSync(path);
      } catch {
        return false;
      }
      if (entries.length !== 0) return false;
    } else if (processIsAlive(currentOwner.pid)) return false;
    const currentSnapshot = ownerSnapshot(path);
    const quarantine = `${path}.abandoned-${process.pid}-${randomUUID()}`;
    try { renameSync(path, quarantine); } catch { return false; }
    if (!sameOwnerSnapshot(quarantine, currentSnapshot)) {
      restoreMovedPath(quarantine, path);
      return false;
    }
    if (!removeClaimPath(quarantine)) return false;
  }
  return restoreMovedPath(fencePath, path);
}

function hasInFlightFence(path) {
  for (const fencePath of fencePaths(path)) {
    if (!recoverAbandonedFence(path, fencePath)) return true;
  }
  return fencePaths(path).length > 0;
}

function rollbackOwnedPath(path, owner) {
  const expected = ownerSnapshot(path);
  if (!expected.owner
    || expected.owner.pid !== owner.pid
    || expected.owner.nonce !== owner.nonce) return;
  const tombstone = takeOwnerPath(path, expected, 'claim-rollback');
  if (!tombstone) return;
  removeClaimPath(tombstone);
}

function cleanupCreatedClaim(path, identity) {
  const current = pathIdentity(path);
  if (!identity || !current || !current.isDirectory || !samePathIdentity(identity, current)) return false;
  return removeClaimPath(path);
}

function removePathIfUnchanged(path, expectedIdentity) {
  testOwnerInterlock('marker-remove');
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

function claimExpired(snapshot, nowMs) {
  if (!snapshot.identity) return false;
  if (snapshot.owner) return !processIsAlive(snapshot.owner.pid);
  return nowMs - snapshot.identity.mtimeMs > MARKER_CLAIM_TTL_MS;
}

function acquireMarkerClaim(marker, nowMs) {
  const claimPath = join(dirname(marker), `.cah-marker-claim-${basename(marker)}`);
  const owner = claimOwner(nowMs);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (hasInFlightFence(claimPath)) return null;
    let createdIdentity = null;
    try {
      // mkdir is the portable atomic ownership operation. Metadata is
      // written inside the directory only after mkdir has won the race.
      mkdirSync(claimPath);
      createdIdentity = pathIdentity(claimPath);
      testOwnerInterlock('owner-write');
      writeFileSync(join(claimPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      if (hasInFlightFence(claimPath)) {
        rollbackOwnedPath(claimPath, owner);
        return null;
      }
      return { marker, claimPath, owner };
    } catch (error) {
      if (createdIdentity) {
        cleanupCreatedClaim(claimPath, createdIdentity);
        return null;
      }
      if (!error || error.code !== 'EEXIST') return null;
      if (hasInFlightFence(claimPath)) return null;
      const expected = ownerSnapshot(claimPath);
      if (!claimExpired(expected, nowMs)) return null;
      const tombstone = takeOwnerPath(claimPath, expected, 'claim-reclaim');
      if (!tombstone) continue;
      if (!removeClaimPath(tombstone)) return null;
    }
  }
  return null;
}

function markerClaimOwned(claim) {
  if (!claim) return false;
  const owner = readClaimOwner(claim.claimPath);
  return owner !== null && owner.pid === claim.owner.pid && owner.nonce === claim.owner.nonce;
}

function releaseMarkerClaim(claim) {
  const expected = { owner: claim && claim.owner, identity: fileIdentity(claim && claim.claimPath) };
  if (!claim || !expected.owner || !markerClaimOwned(claim)) return;
  const tombstone = takeOwnerPath(claim.claimPath, expected, 'claim-release');
  if (!tombstone) return;
  removeClaimPath(tombstone);
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
        if (!removePathIfUnchanged(marker, markerStat)) {
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
  const markerDir = join(home, '.claude');
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
