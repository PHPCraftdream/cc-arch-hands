// Portable directory leases used by the hooks and the update cache.
//
// Ownership is published only after mkdir wins the race.  Reclamation first
// moves the old claim to a private sibling fence, validates what moved, and
// never restores over a successor.  This is intentionally path based: it is
// the strongest portable primitive available to Node on all supported hosts.

import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, opendirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync, linkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isOlderThan } from './fsutil.js';

export const LEASE_MAX_MS = 5 * 60 * 1000;
export const LEASE_RECOVERY_WAIT_MS = 250;
const TRANSIENT_LEASE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const LEASE_QUARANTINE_DIR = '.cah-lease-quarantine';
// A quarantine destination is normally the original fence basename below the
// root.  If that deterministic name is already occupied, use one of these
// fixed slots instead.  The finite namespace is important: repeated recovery
// must not grow a suffix chain, and every move must preserve an existing entry.
const LEASE_QUARANTINE_SLOTS = 32;
// Bounded attempts for removing the fence after takeFence succeeded. The
// removal loop races one total budget of attempts × LEASE_RECOVERY_WAIT_MS.
const RELEASE_CLAIM_REMOVAL_ATTEMPTS = 3;
const PRUNE_QUARANTINE_DIR = '.cah-capacity-quarantine';
const directoryScanStats = {
  enabled: false, lookaheadCalls: 0, visited: 0, inspections: 0, scans: 0, scanVisits: 0,
};

export function resetDirectoryScanStats() {
  directoryScanStats.enabled = true;
  directoryScanStats.lookaheadCalls = 0;
  directoryScanStats.visited = 0;
  directoryScanStats.inspections = 0;
  directoryScanStats.scans = 0;
  directoryScanStats.scanVisits = 0;
}

export function readDirectoryScanStats() {
  return {
    lookaheadCalls: directoryScanStats.lookaheadCalls,
    visited: directoryScanStats.visited,
    inspections: directoryScanStats.inspections,
    scans: directoryScanStats.scans,
    scanVisits: directoryScanStats.scanVisits,
  };
}

export function clearDirectoryScanStats() { directoryScanStats.enabled = false; }

export function recordDirectoryInspection() {
  if (directoryScanStats.enabled) directoryScanStats.inspections += 1;
}
const OWNED_FILE_FENCE_MARKER = '.cah-owned-file-';
const OWNED_FILE_RECOVERY_LIMIT = 32;

// Hook state lives beside other cache data, so never turn a maintenance pass
// into an unbounded readdir of a shared directory.  Callers still get a
// deterministic `complete` bit when they need to distinguish EOF from a cap.
export function streamDirectoryEntries(dir, maxEntries, onEntry) {
  if (directoryScanStats.enabled) directoryScanStats.scans += 1;
  let handle;
  let visited = 0;
  let complete = false;
  try {
    handle = opendirSync(dir);
    while (visited < maxEntries) {
      const entry = handle.readSync();
      if (entry === null) {
        complete = true;
        break;
      }
      visited += 1;
      onEntry(entry);
    }
  } catch {
    // Best-effort maintenance. The caller must preserve state when an
    // enumeration cannot be completed.
  } finally {
    try { handle?.closeSync(); } catch { /* best effort */ }
  }
  if (directoryScanStats.enabled) directoryScanStats.scanVisits += visited;
  return { visited, complete };
}

// Read at most maxEntries and one extra directory entry. The extra read makes
// an exact-cap directory distinguishable from a truncated enumeration.
export function streamDirectoryEntriesLookahead(dir, maxEntries, onEntry) {
  if (directoryScanStats.enabled) directoryScanStats.lookaheadCalls += 1;
  let handle;
  let visited = 0;
  let complete = false;
  let truncated = false;
  const limit = Math.max(0, Number.isSafeInteger(maxEntries) ? maxEntries : 0);
  try {
    handle = opendirSync(dir);
    while (visited < limit) {
      const entry = handle.readSync();
      if (entry === null) {
        complete = true;
        break;
      }
      visited += 1;
      onEntry(entry);
    }
    if (!complete) {
      const lookahead = handle.readSync();
      complete = lookahead === null;
      truncated = !complete;
    }
  } catch {
    complete = false;
  } finally {
    try { handle?.closeSync(); } catch { /* best effort */ }
  }
  if (directoryScanStats.enabled) directoryScanStats.visited += visited;
  return { visited, complete, truncated };
}

function sleepSync(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function isTransientLeaseError(error) {
  return Boolean(error && TRANSIENT_LEASE_ERRORS.has(error.code));
}

function retryDelay(attempt) {
  return Math.min(10 * (2 ** Math.min(attempt, 3)), 80);
}

function withTransientRetry(action, deadline) {
  let attempt = 0;
  while (true) {
    try {
      return { ok: true, value: action() };
    } catch (error) {
      if (!isTransientLeaseError(error) || deadline === null || deadline === undefined) {
        return { ok: false, error };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error };
      sleepSync(Math.min(retryDelay(attempt), remaining));
      attempt += 1;
    }
  }
}

function tokenOf(owner) {
  return typeof owner?.token === 'string' && owner.token
    ? owner.token
    : typeof owner?.nonce === 'string' && owner.nonce
      ? owner.nonce
      : null;
}

function generationOf(owner) {
  return typeof owner?.generation === 'string' && owner.generation
    ? owner.generation
    : null;
}

function sameOwnerIdentity(expected, actual) {
  const expectedToken = tokenOf(expected);
  const actualToken = tokenOf(actual);
  if (!expectedToken || expectedToken !== actualToken) return false;
  const expectedGeneration = generationOf(expected);
  return expectedGeneration === null || expectedGeneration === generationOf(actual);
}

function timestampOf(owner) {
  for (const key of ['timestamp', 'startedAt', 'claimedAt']) {
    if (Number.isFinite(owner?.[key])) return owner[key];
  }
  return null;
}

export function ownerToken(owner) {
  return tokenOf(owner);
}

export function ownerGeneration(owner) {
  return generationOf(owner);
}

export function ownerTimestamp(owner) {
  return timestampOf(owner);
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists. Reclaiming in that case could destroy a
    // live caller's state, so only ESRCH is considered dead.
    return !(error && error.code === 'ESRCH');
  }
}

export function pathIdentity(path) {
  try {
    const info = lstatSync(path, { bigint: true });
    const identity = {
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      size: info.size,
      nlink: info.nlink,
      mtimeNs: info.mtimeNs,
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      isSymbolicLink: info.isSymbolicLink(),
      contentDigest: null,
    };
    // Lease/marker/sidecar files are deliberately tiny managed state. Their
    // bytes are part of the path snapshot so an in-place same-size mutation
    // with restored mtime/mode cannot pass a destructive CAS.
    if (info.isFile()) {
      const data = readFileSync(path);
      identity.contentDigest = createHash('sha256').update(data).digest('hex');
    }
    return identity;
  } catch {
    return null;
  }
}

export function samePathIdentity(left, right) {
  const leftDirectory = typeof left?.isDirectory === 'function'
    ? left.isDirectory() : Boolean(left?.isDirectory);
  const rightDirectory = typeof right?.isDirectory === 'function'
    ? right.isDirectory() : Boolean(right?.isDirectory);
  const leftFile = typeof left?.isFile === 'function' ? left.isFile() : Boolean(left?.isFile);
  const rightFile = typeof right?.isFile === 'function' ? right.isFile() : Boolean(right?.isFile);
  const leftLink = typeof left?.isSymbolicLink === 'function'
    ? left.isSymbolicLink() : Boolean(left?.isSymbolicLink);
  const rightLink = typeof right?.isSymbolicLink === 'function'
    ? right.isSymbolicLink() : Boolean(right?.isSymbolicLink);
  if (!left || !right
      || left.dev !== right.dev
      || left.ino !== right.ino
      || left.mode !== right.mode
      || leftDirectory !== rightDirectory
      || leftFile !== rightFile
      || leftLink !== rightLink) return false;
  if (leftDirectory) return true;
  if (left.size !== right.size || left.mtimeNs !== right.mtimeNs) return false;
  if (left.nlink !== undefined && right.nlink !== undefined && left.nlink !== right.nlink) {
    return false;
  }
  // Raw fs.Stats values remain accepted for compatibility, but all managed
  // regular-file consumers pass the digest-bearing pathIdentity shape.
  return left.contentDigest === undefined || right.contentDigest === undefined
    ? true
    : left.contentDigest === right.contentDigest;
}

function fileIdentity(path) {
  return pathIdentity(path);
}

function ownerPath(claimPath, ownerFile) {
  try {
    return lstatSync(claimPath, { bigint: true }).isDirectory() ? join(claimPath, ownerFile) : claimPath;
  } catch {
    return join(claimPath, ownerFile);
  }
}

export function readLeaseOwner(claimPath, ownerFile = 'owner.json') {
  try {
    const value = JSON.parse(readFileSync(ownerPath(claimPath, ownerFile), 'utf8'));
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !tokenOf(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function ownerSnapshot(path, readOwner) {
  return { owner: readOwner(path), identity: fileIdentity(path) };
}

function sameOwnerSnapshot(path, expected, readOwner) {
  const actualOwner = readOwner(path);
  if (expected.owner && actualOwner) return sameOwnerIdentity(expected.owner, actualOwner);
  return expected.owner === null && actualOwner === null
    && samePathIdentity(expected.identity, fileIdentity(path));
}

function removeClaimPath(path, ownerFile = 'owner.json', deadline = null) {
  try {
    const info = lstatSync(path, { bigint: true });
    if (info.isDirectory()) {
      const entries = readdirSync(path);
      if (entries.some((entry) => entry !== ownerFile)) return false;
      if (entries.includes(ownerFile)) {
        const removedOwner = withTransientRetry(() => unlinkSync(join(path, ownerFile)), deadline);
        if (!removedOwner.ok) return Boolean(removedOwner.error && removedOwner.error.code === 'ENOENT');
      }
      const removedDirectory = withTransientRetry(() => rmdirSync(path), deadline);
      if (!removedDirectory.ok) return Boolean(removedDirectory.error && removedDirectory.error.code === 'ENOENT');
    } else {
      const removedFile = withTransientRetry(() => unlinkSync(path), deadline);
      if (!removedFile.ok) return Boolean(removedFile.error && removedFile.error.code === 'ENOENT');
    }
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

// Restore by exclusive creation. A successor at `target` is never replaced.
function restoreWithoutOverwrite(source, target, ownerFile = 'owner.json', deadline = null) {
  const sourceIdentity = pathIdentity(source);
  if (!sourceIdentity) return false;
  if (sourceIdentity.isDirectory) {
    let created = false;
    let targetIdentity = null;
    try {
      mkdirSync(target);
      created = true;
      targetIdentity = pathIdentity(target);
      const entries = readdirSync(source);
      if (entries.length > 0) {
        if (entries.length !== 1 || entries[0] !== ownerFile) throw new Error('unexpected lease fence contents');
        const movedOwner = withTransientRetry(
          () => renameSync(join(source, ownerFile), join(target, ownerFile)),
          deadline,
        );
        if (!movedOwner.ok) throw movedOwner.error;
      }
      rmdirSync(source);
      return true;
    } catch {
      if (created && samePathIdentity(targetIdentity, pathIdentity(target))) {
        try { rmdirSync(target); } catch { /* preserve a successor */ }
      }
      return false;
    }
  }

  // A link or special entry is not a regular file. Restore it by moving the
  // exact directory entry so a failed CAS never follows or rewrites it.
  if (!sourceIdentity.isFile) {
    try {
      if (pathIdentity(target)) return false;
      renameSync(source, target);
      return true;
    } catch {
      return false;
    }
  }

  let data;
  try { data = readFileSync(source); } catch { return false; }
  let fd = null;
  let targetIdentity = null;
  try {
    fd = openSync(target, 'wx', 0o600);
    targetIdentity = pathIdentity(target);
    writeSync(fd, data);
    closeSync(fd);
    fd = null;
    if (!samePathIdentity(sourceIdentity, pathIdentity(source))) return false;
    unlinkSync(source);
    return true;
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
      if (samePathIdentity(targetIdentity, pathIdentity(target))) {
        try { unlinkSync(target); } catch { /* preserve a successor */ }
      }
    }
    return false;
  }
}

// Capacity transactions use the same owner interlock as leases so tests can
// pause precisely between victim selection and the durable publication.
function testInterlock(phase, stage, options = null) {
  if (typeof options?.testInterlock === 'function') {
    options.testInterlock(phase, stage);
    return;
  }
  return;
}

function fencePaths(path, fenceSuffix) {
  const prefix = `${basename(path)}${fenceSuffix}`;
  try {
    return readdirSync(dirname(path))
      .filter((name) => {
        if (!name.startsWith(prefix)) return false;
        const suffix = name.slice(prefix.length);
        // Older releases placed quarantined fences beside the live fence
        // names. Keep those entries out of the active set so they cannot be
        // quarantined repeatedly, while new quarantines live below the fixed
        // namespace above and never match this directory scan.
        if (suffix.includes('.orphan-') || suffix.includes('.quarantine-')) return false;
        return /^\d+-[^/]+$/.test(suffix);
      })
      .map((name) => join(dirname(path), name));
  } catch {
    return [];
  }
}

function fencePid(path, fencePath, fenceSuffix) {
  const prefix = `${basename(path)}${fenceSuffix}`;
  const match = /^(\d+)-/.exec(basename(fencePath).slice(prefix.length));
  return match ? Number.parseInt(match[1], 10) : null;
}

function moveFenceContents(source, target, deadline) {
  let reserved = false;
  try {
    // mkdir is the exclusive reservation.  renameSync(target) alone is not a
    // no-overwrite primitive on every supported filesystem.
    mkdirSync(target);
    reserved = true;
    for (const entry of readdirSync(source)) {
      const moved = withTransientRetry(
        () => renameSync(join(source, entry), join(target, entry)),
        deadline,
      );
      if (!moved.ok) throw moved.error;
    }
    rmdirSync(source);
    return true;
  } catch {
    // Do not remove a partially populated destination: both the source
    // remainder and the moved entries must stay recoverable.  An empty
    // reservation can be cleaned up so a later bounded slot attempt works.
    if (reserved) {
      try {
        if (readdirSync(target).length === 0) rmdirSync(target);
      } catch { /* preserve anything that appeared concurrently */ }
    }
    return false;
  }
}

function quarantineUnexpectedFence(fencePath, ownerFile, deadline) {
  try {
    if (!lstatSync(fencePath, { bigint: true }).isDirectory()) return false;
    const entries = readdirSync(fencePath);
    if (!entries.some((entry) => entry !== ownerFile)) return false;
  } catch {
    return false;
  }
  return quarantineFenceDir(fencePath, deadline);
}

// Preserve an undisposable fence under the fixed quarantine namespace. The
// exclusive mkdir in moveFenceContents keeps every destination safe against
// competing reclaimers; an occupied destination falls through to the next slot.
function quarantineFenceDir(fencePath, deadline) {
  try {
    const quarantineRoot = join(dirname(fencePath), LEASE_QUARANTINE_DIR);
    mkdirSync(quarantineRoot, { recursive: true });
    const fenceName = basename(fencePath);
    if (moveFenceContents(fencePath, join(quarantineRoot, fenceName), deadline)) return true;
    for (let slot = 0; slot < LEASE_QUARANTINE_SLOTS; slot += 1) {
      const slotDir = join(quarantineRoot, `.slot-${slot}`);
      try { mkdirSync(slotDir); } catch { continue; }
      if (moveFenceContents(fencePath, join(slotDir, fenceName), deadline)) return true;
      try { rmdirSync(slotDir); } catch { /* preserve concurrent contents */ }
    }
    return false;
  } catch {
    return false;
  }
}

function recoverFence(path, fencePath, options) {
  const {
    fenceSuffix, ownerFile, readOwner, maxLeaseMs, nowMs, pidIsAlive, recoveryDeadline,
  } = options;
  const operatorPid = fencePid(path, fencePath, fenceSuffix);
  const fencedIdentity = fileIdentity(fencePath);
  if (!fencedIdentity) return true;
  const fenceExpired = isOlderThan(fencedIdentity, nowMs, maxLeaseMs);
  if (!Number.isInteger(operatorPid) || operatorPid <= 0) return false;
  if (pidIsAlive(operatorPid) && !fenceExpired) return false;
  if (quarantineUnexpectedFence(fencePath, ownerFile, recoveryDeadline)) return true;

  const currentIdentity = fileIdentity(path);
  if (currentIdentity && samePathIdentity(fencedIdentity, currentIdentity)) {
    return removeClaimPath(fencePath, ownerFile, recoveryDeadline);
  }
  if (currentIdentity) {
    const currentOwner = readOwner(path);
    const currentLeaseExpired = currentOwner
      && (!pidIsAlive(currentOwner.pid)
        || (ownerTimestamp(currentOwner) !== null
          && nowMs >= ownerTimestamp(currentOwner)
          && nowMs - ownerTimestamp(currentOwner) > maxLeaseMs));
    if (currentOwner && !currentLeaseExpired) {
      // The old fence is abandoned, but a successor is live. Its claim wins.
      return (!pidIsAlive(operatorPid) || fenceExpired)
        ? removeClaimPath(fencePath, ownerFile, recoveryDeadline)
        : false;
    }
    const currentSnapshot = ownerSnapshot(path, readOwner);
    const quarantine = `${path}.abandoned-${process.pid}-${randomUUID()}`;
    const movedCurrent = withTransientRetry(
      () => renameSync(path, quarantine),
      recoveryDeadline,
    );
    if (!movedCurrent.ok) return false;
    if (!sameOwnerSnapshot(quarantine, currentSnapshot, readOwner)) {
      restoreWithoutOverwrite(quarantine, path, ownerFile, recoveryDeadline);
      return false;
    }
    // Restore the old fence before deleting the displaced claim. If a new
    // successor appeared while the path was vacant, the displaced content
    // stays quarantined and can never be mistaken for disposable state.
    if (!restoreWithoutOverwrite(fencePath, path, ownerFile, recoveryDeadline)) return false;
    return removeClaimPath(quarantine, ownerFile, recoveryDeadline);
  }
  return restoreWithoutOverwrite(fencePath, path, ownerFile, recoveryDeadline);
}

function hasInFlightFence(path, options, ignoredFence = null) {
  let blocked = false;
  for (const fencePath of fencePaths(path, options.fenceSuffix)) {
    if (fencePath === ignoredFence) continue;
    if (!recoverFence(path, fencePath, options)) blocked = true;
  }
  return blocked || fencePaths(path, options.fenceSuffix).some((fence) => fence !== ignoredFence);
}

function claimExpired(snapshot, options) {
  if (!snapshot.identity) return false;
  if (snapshot.owner) {
    if (!options.pidIsAlive(snapshot.owner.pid)) return true;
    const timestamp = ownerTimestamp(snapshot.owner);
    return timestamp !== null && options.nowMs >= timestamp
      && options.nowMs - timestamp > options.maxLeaseMs;
  }
  return isOlderThan(snapshot.identity, options.nowMs, options.staleAfterMs);
}

function takeFence(path, expected, options) {
  const fencePath = `${path}${options.fenceSuffix}${process.pid}-${randomUUID()}`;
  testInterlock(options.interlockPhase, 'before', options);
  const moved = withTransientRetry(
    () => renameSync(path, fencePath),
    options.recoveryDeadline,
  );
  if (!moved.ok) return { path: null, error: moved.error };
  testInterlock(options.interlockPhase, 'vacancy', options);
  if (sameOwnerSnapshot(fencePath, expected, options.readOwner)) return { path: fencePath, owner: expected.owner };
  restoreWithoutOverwrite(fencePath, path, options.ownerFile, options.recoveryDeadline);
  return { path: null, error: null };
}

export function acquireLease(path, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const testLeaseMs = process.env.CAH_TEST_ONLY === '1'
    ? Number.parseInt(process.env[options.testLeaseEnv || ''] || '', 10)
    : NaN;
  const maxLeaseMs = Number.isFinite(testLeaseMs) && testLeaseMs > 0 ? testLeaseMs : LEASE_MAX_MS;
  const ownerFile = options.ownerFile || 'owner.json';
  const readOwner = (candidate) => readLeaseOwner(candidate, ownerFile);
  const owner = {
    ...(options.owner || {}),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.owner ? {} : {
      pid: process.pid,
      token: randomUUID(),
      generation: randomUUID(),
      timestamp: nowMs,
    }),
  };
  if (!generationOf(owner)) owner.generation = randomUUID();
  const config = {
    ownerFile,
    readOwner,
    nowMs,
    maxLeaseMs,
    staleAfterMs: options.staleAfterMs ?? 30_000,
    fenceSuffix: options.fenceSuffix ?? '.taken-',
    interlockPhase: options.interlockPhase || 'lease-reclaim',
    releaseInterlockPhase: options.releaseInterlockPhase || options.interlockPhase || 'lease-release',
    pidIsAlive: options.pidIsAlive || processIsAlive,
    recoveryDeadline: Date.now() + LEASE_RECOVERY_WAIT_MS,
    testInterlock: options.testInterlock,
  };

  try { mkdirSync(dirname(path), { recursive: true }); } catch { return null; }
  while (Date.now() < config.recoveryDeadline) {
    if (hasInFlightFence(path, config)) return null;
    try {
      mkdirSync(path);
      testInterlock('lease-owner-write', 'before', config);
      writeFileSync(join(path, ownerFile), JSON.stringify(owner) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      if (hasInFlightFence(path, config)) {
        releaseLease({ path, owner, options: config });
        return null;
      }
      return {
        path,
        owner,
        token: tokenOf(owner),
        generation: generationOf(owner),
        options: config,
      };
    } catch (error) {
      try {
        if (pathIdentity(path)?.isDirectory && readdirSync(path).length === 0) rmdirSync(path);
      } catch { /* preserve a changed claim */ }
      if (!error || error.code !== 'EEXIST') return null;
      if (hasInFlightFence(path, config)) return null;
      const expected = ownerSnapshot(path, readOwner);
      if (!claimExpired(expected, config)) return null;
      const fence = takeFence(path, expected, config);
      if (!fence.path) return null;
      if (hasInFlightFence(path, config, fence.path)) {
        restoreWithoutOverwrite(fence.path, path, ownerFile, config.recoveryDeadline);
        return null;
      }
      if (!removeClaimPath(fence.path, ownerFile, config.recoveryDeadline)) return null;
      continue;
    }
  }
  return null;
}

export function leaseOwned(lease) {
  if (!lease?.path || !lease.owner) return false;
  const owner = (lease.options?.readOwner || ((path) => readLeaseOwner(path)))(lease.path);
  return owner !== null && sameOwnerIdentity(lease.owner, owner);
}

// Verify the original owner and refresh its timestamp without ever writing
// through a path that may have become a successor claim. The common case is a
// cheap owner-file read; only a lease nearing its deadline pays the fenced
// directory rename needed to publish a heartbeat safely.
export function renewLease(lease, nowOrOptions = Date.now()) {
  if (!lease?.path || !lease.owner) return false;
  const nowMs = typeof nowOrOptions === 'object'
    ? nowOrOptions.nowMs ?? Date.now()
    : nowOrOptions;
  if (!Number.isFinite(nowMs)) return false;
  const options = {
    ownerFile: 'owner.json',
    fenceSuffix: '.taken-',
    recoveryDeadline: Date.now() + LEASE_RECOVERY_WAIT_MS,
    ...(lease.options || {}),
  };
  const ownerFile = options.ownerFile || 'owner.json';
  const readOwner = options.readOwner || ((path) => readLeaseOwner(path, ownerFile));
  const current = readOwner(lease.path);
  if (!current || !sameOwnerIdentity(lease.owner, current)) return false;

  const maxLeaseMs = options.maxLeaseMs ?? LEASE_MAX_MS;
  const timestamp = ownerTimestamp(current);
  if (timestamp === null || nowMs < timestamp || nowMs - timestamp > maxLeaseMs) return false;

  // Do not churn the lock directory on every leaf publication. Verification
  // above is sufficient while the current heartbeat is comfortably fresh.
  if (nowMs - timestamp <= Math.max(1, Math.floor(maxLeaseMs / 2))) return true;

  const renewOptions = {
    ...options,
    ownerFile,
    readOwner,
    interlockPhase: options.renewInterlockPhase || 'lease-renew',
    recoveryDeadline: Date.now() + LEASE_RECOVERY_WAIT_MS,
  };
  const fence = takeFence(lease.path, { owner: lease.owner, identity: null }, renewOptions);
  if (!fence.path) return false;

  const renewedOwner = { ...lease.owner, timestamp: nowMs };
  let restored = false;
  try {
    if (!sameOwnerSnapshot(fence.path, { owner: lease.owner, identity: null }, readOwner)) {
      return false;
    }
    writeFileSync(join(fence.path, ownerFile), JSON.stringify(renewedOwner) + '\n', {
      encoding: 'utf8', flag: 'w', mode: 0o600,
    });
    restored = restoreWithoutOverwrite(fence.path, lease.path, ownerFile, renewOptions.recoveryDeadline);
    if (restored) lease.owner = renewedOwner;
    return restored && leaseOwned(lease);
  } finally {
    if (!restored) restoreWithoutOverwrite(fence.path, lease.path, ownerFile, renewOptions.recoveryDeadline);
  }
}

function leaseGenerationAssertion(lease) {
  const path = lease?.path || null;
  const token = tokenOf(lease?.owner);
  const generation = generationOf(lease?.owner);
  return () => Boolean(lease && path && token && generation
    && lease.path === path
    && tokenOf(lease.owner) === token
    && generationOf(lease.owner) === generation
    && leaseOwned(lease));
}

function sameFileInode(left, right) {
  return Boolean(left && right
    && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && (left.contentDigest === undefined || right.contentDigest === undefined
      || left.contentDigest === right.contentDigest));
}

function ownedFilePaths(path, generation, digest = 'unknown', marker = OWNED_FILE_FENCE_MARKER) {
  const prefix = `${path}${marker}`;
  return { prefix, fence: `${prefix}${generation}-${digest}.fence` };
}

function recoverOwnedFileFence(path, fence, authority, options = {}) {
  const assertAuthority = options.assertOwnership || leaseGenerationAssertion(authority);
  const fenceIdentity = pathIdentity(fence);
  if (!fenceIdentity) return true;
  if (!assertAuthority()) return false;

  const expectedDigest = options.expectedDigest || null;
  const currentIdentity = pathIdentity(path);
  // A digest-bearing fence is an anchor, not a displaced pathname. This makes
  // crash recovery safe even when a successor replaced the canonical entry.
  if (expectedDigest !== null && fenceIdentity.contentDigest !== expectedDigest) {
    return quarantineOwnedFileFence(fence, authority, options);
  }
  if (currentIdentity && sameFileInode(currentIdentity, fenceIdentity)) {
    if (!assertAuthority()) return false;
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
  }
  if (!assertAuthority()) return false;
  try { unlinkSync(fence); return true; } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

function quarantineOwnedFileFence(fence, authority, options = {}) {
  const assertAuthority = options.assertOwnership || leaseGenerationAssertion(authority);
  const quarantine = `${fence}.quarantine`;
  let reserved = false;
  try {
    if (!assertAuthority()) return false;
    mkdirSync(quarantine);
    reserved = true;
    if (!assertAuthority()) return false;
    const payload = join(quarantine, 'payload');
    if (pathIdentity(payload)) return false;
    renameSync(fence, payload);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' && !pathIdentity(fence)) return true;
    return false;
  } finally {
    if (reserved && pathIdentity(quarantine)
        && readdirSafe(quarantine).length === 0) {
      try { rmdirSync(quarantine); } catch { /* preserve a changed reservation */ }
    }
  }
}

function readdirSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

// Recover only the fixed, generation-bearing fence namespace. The caller owns
// the current generation; an old live PID is not authority to mutate a fence.
export function recoverOwnedFileFences(path, authority, options = {}) {
  const marker = options.marker || OWNED_FILE_FENCE_MARKER;
  const prefix = `${basename(path)}${marker}`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}[^/]+-(unknown|[a-f0-9]{64})\\.fence$`);
  let ok = true;
  const scan = streamDirectoryEntries(dirname(path),
    options.limit || OWNED_FILE_RECOVERY_LIMIT, (entry) => {
      if (!pattern.test(entry.name)) return;
      const fence = join(dirname(path), entry.name);
      const match = /-(unknown|[a-f0-9]{64})\.fence$/.exec(entry.name);
      if (!recoverOwnedFileFence(path, fence, authority,
        { ...options, expectedDigest: match?.[1] === 'unknown' ? null : match?.[1] })) ok = false;
    });
  return { complete: scan.complete, ok: scan.complete && ok, visits: scan.visited };
}

// Remove a regular file under a lease generation. The canonical entry is
// validated immediately before the hard-link fence and final unlink.
export function removeOwnedFileForGeneration(path, expectedIdentity, authority, phase,
  options = {}) {
  const assertAuthority = options.assertOwnership || leaseGenerationAssertion(authority);
  const generation = generationOf(authority?.owner);
  if (!generation || !expectedIdentity || !assertAuthority()) return { ok: false };
  const marker = options.marker || OWNED_FILE_FENCE_MARKER;
  const digest = typeof expectedIdentity.contentDigest === 'string'
    ? expectedIdentity.contentDigest : 'unknown';
  const { fence } = ownedFilePaths(path, generation, digest, marker);
  if (pathIdentity(fence)) return { ok: false, fence };
  const current = pathIdentity(path);
  if (!sameFileInode(current, expectedIdentity)) return { ok: false };
  options.testInterlock?.(phase, 'before');
  if (!assertAuthority() || !sameFileInode(pathIdentity(path), expectedIdentity)) return { ok: false };
  try {
    // Hard-linking creates a generation-specific recovery anchor without
    // moving the canonical entry or displacing a successor.
    linkSync(path, fence);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false };
    throw error;
  }
  const fenced = pathIdentity(fence);
  if (!sameFileInode(fenced, expectedIdentity)) {
    recoverOwnedFileFence(path, fence, authority, { ...options, expectedDigest: digest });
    return { ok: false, fence };
  }
  if (process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_STAMP_SIDECAR_CRASH === 'after-fence'
        || process.env.CAH_TEST_ONLY_STAMP_SIDECAR_CRASH === 'after-rename')) process.exit(97);
  options.testInterlock?.(`${phase}-after-fence`, 'before');
  // A lost generation leaves the fence for the next generation's bounded
  // recovery pass. It must not mutate through a successor pathname.
  if (!assertAuthority()) return { ok: false, fence };
  if (!sameFileInode(pathIdentity(path), expectedIdentity)
      || !sameFileInode(pathIdentity(fence), expectedIdentity)) {
    recoverOwnedFileFence(path, fence, authority, { ...options, expectedDigest: digest });
    return { ok: false, fence };
  }
  if (process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_STAMP_SIDECAR_CRASH === 'before-unlink'
        || process.env.CAH_TEST_ONLY_STAMP_SIDECAR_CRASH === 'before-final-unlink')) process.exit(98);
  try {
    if (!assertAuthority() || !sameFileInode(pathIdentity(path), expectedIdentity)) {
      return { ok: false, fence };
    }
    unlinkSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, fence };
    return { ok: false, fence };
  }
  if (process.env.CAH_TEST_ONLY === '1' && process.env.CAH_TEST_ONLY_STAMP_SIDECAR_CRASH === 'after-unlink') {
    process.exit(98);
  }
  if (!assertAuthority()) return { ok: false, fence };
  try { unlinkSync(fence); return { ok: true }; } catch (error) {
    return error?.code === 'ENOENT' ? { ok: true } : { ok: false, fence };
  }
}

// A fence at fencePath was created by takeFence() in this process: the name
// carries process.pid and sameOwnerSnapshot() validated the displaced claim
// before the rename returned. Everything inside is therefore this process's
// own state: dispose outright, or quarantine a stray entry for a later reclaimer.
function disposeOwnFence(fencePath, ownerFile, deadline) {
  let entries;
  try {
    if (!lstatSync(fencePath, { bigint: true }).isDirectory()) return false;
    entries = readdirSync(fencePath);
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
  if (entries.every((entry) => entry === ownerFile)
      && removeClaimPath(fencePath, ownerFile, deadline)) {
    return true;
  }
  return quarantineFenceDir(fencePath, deadline);
}

export function releaseLease(lease) {
  if (!lease?.path || !lease.owner || !leaseOwned(lease)) return false;
  const options = lease.options || {
    ownerFile: 'owner.json',
    readOwner: (path) => readLeaseOwner(path),
    fenceSuffix: '.taken-',
    interlockPhase: 'lease-release',
    releaseInterlockPhase: 'lease-release',
  };
  // The recovery deadline stored on the lease was spent at acquire time.
  // Release computes one fresh phase budget here: takeFence spends it and the
  // removal loop below races its own identical budget, so a pin outlasting one
  // window is still retried and neither phase can multiply or starve the other.
  const releaseOptions = {
    ...options,
    interlockPhase: options.releaseInterlockPhase || 'lease-release',
    recoveryDeadline: Date.now() + RELEASE_CLAIM_REMOVAL_ATTEMPTS * LEASE_RECOVERY_WAIT_MS,
  };
  // The ownership check above is intentionally only a fast-fail guard. The
  // path may change before fencing; the expected owner must remain the lease
  // being released, never a successor snapshot taken from the path.
  testInterlock(releaseOptions.interlockPhase, 'before', releaseOptions);
  const expected = { owner: lease.owner, identity: null };
  const fence = takeFence(lease.path, expected, releaseOptions);
  if (!fence.path) return false;
  // After takeFence renames the claim onto the fence, lease.path is vacant.
  // A retry that re-entered from the top could only fail the ownership guard
  // and strand the fence, so the bounded retry must resume from fence.path.
  // takeFence spends releaseOptions.recoveryDeadline; the removal loop races
  // one removal budget computed once here, so neither budget multiplies the other.
  const removalDeadline = Date.now() + RELEASE_CLAIM_REMOVAL_ATTEMPTS * LEASE_RECOVERY_WAIT_MS;
  for (let attempt = 0; attempt < RELEASE_CLAIM_REMOVAL_ATTEMPTS; attempt += 1) {
    testInterlock(releaseOptions.interlockPhase, 'claim-removal', releaseOptions);
    if (removeClaimPath(fence.path, options.ownerFile, removalDeadline)) return true;
  }
  // Every rejection above leaves behind a fence this process provably created,
  // so terminal disposal is unconditional: an owner.json-only or empty fence
  // is removed or quarantined, a stray entry is quarantined.
  return disposeOwnFence(fence.path, options.ownerFile, removalDeadline);
}

function pruneQuarantinePath(path) {
  return join(dirname(path), PRUNE_QUARANTINE_DIR, 'victim');
}

// Remove a validated managed file without leaking a new `.prune-*` file on
// every failed attempt.  The displaced inode is restored when possible; if a
// successor occupies the canonical name, it is moved to one deterministic,
// reportable quarantine path.  A later attempt cannot create another slot for
// the same leaf while that recovery entry is present.
export function removePathIfUnchangedRecoverable(
  path, expectedIdentity, phase = 'lease-remove', options = {},
) {
  if (!isRegularSingleLink(expectedIdentity)) return { ok: false, restored: false, quarantinePath: null };
  const deadline = Date.now() + LEASE_RECOVERY_WAIT_MS;
  testInterlock(phase, 'before', options);
  const quarantine = pruneQuarantinePath(path);
  if (phase.includes('capacity') && pathIdentity(quarantine)) {
    return { ok: false, restored: false, quarantinePath: quarantine };
  }
  const fence = `${path}.cah-capacity-fence`;
  // A previous failed final fence operation is itself the bounded recovery
  // record. Do not stack another temporary file beside it.
  if (pathIdentity(fence)) return { ok: false, restored: false, quarantinePath: quarantine };
  const moved = withTransientRetry(() => renameSync(path, fence), deadline);
  if (!moved.ok) return { ok: false, restored: false, quarantinePath: null };
  const fencedIdentity = fileIdentity(fence);
  if (!isRegularSingleLink(fencedIdentity)
      || !samePathIdentity(expectedIdentity, fencedIdentity)) {
    const restored = restoreWithoutOverwrite(fence, path, 'owner.json', deadline);
    return { ok: false, restored, quarantinePath: restored ? null : preservePruneFence(fence, path, deadline) };
  }
  try {
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_FINAL_UNLINK_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE === '1'
          || process.env.CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE === '1')
        && phase.includes('capacity')) {
      const error = new Error('test-only final unlink failure');
      error.code = 'EACCES';
      throw error;
    }
    unlinkSync(fence);
    return { ok: true, restored: false, quarantinePath: null };
  } catch {
    const restored = restoreWithoutOverwrite(fence, path, 'owner.json', deadline);
    return { ok: false, restored, quarantinePath: restored ? null : preservePruneFence(fence, path, deadline) };
  }
}

function preservePruneFence(fence, path, deadline) {
  const quarantine = pruneQuarantinePath(path);
  try {
    mkdirSync(dirname(quarantine), { recursive: true });
    if (pathIdentity(quarantine)) return quarantine;
    const moved = withTransientRetry(() => renameSync(fence, quarantine), deadline);
    return moved.ok ? quarantine : null;
  } catch {
    return pathIdentity(quarantine) ? quarantine : null;
  }
}

function isRegularSingleLink(identity) {
  if (!identity) return false;
  const isFile = typeof identity.isFile === 'function' ? identity.isFile() : identity.isFile === true;
  const isDirectory = typeof identity.isDirectory === 'function'
    ? identity.isDirectory() : identity.isDirectory === true;
  const isLink = typeof identity.isSymbolicLink === 'function'
    ? identity.isSymbolicLink() : identity.isSymbolicLink === true;
  if (!isFile || isDirectory || isLink) return false;
  return identity.nlink === undefined || identity.nlink === 1 || identity.nlink === 1n;
}
