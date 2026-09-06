// Portable directory leases used by the hooks and the update cache.
//
// Ownership is published only after mkdir wins the race.  Reclamation first
// moves the old claim to a private sibling fence, validates what moved, and
// never restores over a successor.  This is intentionally path based: it is
// the strongest portable primitive available to Node on all supported hosts.

import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, opendirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isOlderThan } from './fsutil.js';

export const LEASE_MAX_MS = 5 * 60 * 1000;
export const LEASE_RECOVERY_WAIT_MS = 250;
const TEST_INTERLOCK_TIMEOUT_MS = 10_000;
const TRANSIENT_LEASE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const LEASE_QUARANTINE_DIR = '.cah-lease-quarantine';
// A quarantine destination is normally the original fence basename below the
// root.  If that deterministic name is already occupied, use one of these
// fixed slots instead.  The finite namespace is important: repeated recovery
// must not grow a suffix chain, and every move must preserve an existing entry.
const LEASE_QUARANTINE_SLOTS = 32;
const PRUNE_QUARANTINE_DIR = '.cah-capacity-quarantine';

// Hook state lives beside other cache data, so never turn a maintenance pass
// into an unbounded readdir of a shared directory.  Callers still get a
// deterministic `complete` bit when they need to distinguish EOF from a cap.
export function streamDirectoryEntries(dir, maxEntries, onEntry) {
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
  return { visited, complete };
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

function testInterlockConfigured() {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const base = process.env.CAH_TEST_ONLY_OWNER_INTERLOCK
    || process.env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK;
  const configured = process.env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE
    || process.env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK_PHASE;
  return Boolean(base && configured);
}

function interlockDeadline() {
  return Date.now() + (testInterlockConfigured()
    ? TEST_INTERLOCK_TIMEOUT_MS
    : LEASE_RECOVERY_WAIT_MS);
}

function tokenOf(owner) {
  return typeof owner?.token === 'string' && owner.token
    ? owner.token
    : typeof owner?.nonce === 'string' && owner.nonce
      ? owner.nonce
      : null;
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
  if (expected.owner && actualOwner) return tokenOf(expected.owner) === tokenOf(actualOwner);
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

function testInterlock(phase, stage, deadline) {
  // This is the only production-path environment read in the lease module.
  if (process.env.CAH_TEST_ONLY !== '1') return;
  const base = process.env.CAH_TEST_ONLY_OWNER_INTERLOCK
    || process.env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK;
  const configured = process.env.CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE
    || process.env.CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK_PHASE;
  if (!base || !configured) return;
  const staged = configured === `${phase}-three-party`;
  if ((!staged && (configured !== phase || stage !== 'before'))) return;
  const readyBase = staged ? `${base}.${stage}` : base;
  try { writeFileSync(`${readyBase}.ready`, `${phase}:${stage}`, { flag: 'wx' }); } catch { return; }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try { lstatSync(`${readyBase}.go`, { bigint: true }); return; } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      Atomics.wait(signal, 0, 0, Math.min(10, remaining));
    }
  }
  throw new Error(`lease test interlock timed out for ${phase}:${stage}`);
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

    const quarantineRoot = join(dirname(fencePath), LEASE_QUARANTINE_DIR);
    mkdirSync(quarantineRoot, { recursive: true });
    const fenceName = basename(fencePath);

    // Keep the historical readable location when it is free.  The exclusive
    // mkdir in moveFenceContents makes this safe even with competing
    // reclaimers; an occupied primary falls through to the bounded slots.
    if (moveFenceContents(fencePath, join(quarantineRoot, fenceName), deadline)) return true;

    for (let slot = 0; slot < LEASE_QUARANTINE_SLOTS; slot += 1) {
      const slotDir = join(quarantineRoot, `.slot-${slot}`);
      try { mkdirSync(slotDir, { recursive: true }); } catch { continue; }
      if (moveFenceContents(fencePath, join(slotDir, fenceName), deadline)) return true;
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
  testInterlock(options.interlockPhase, 'before', options.interlockDeadline);
  const moved = withTransientRetry(
    () => renameSync(path, fencePath),
    options.recoveryDeadline,
  );
  if (!moved.ok) return { path: null, error: moved.error };
  testInterlock(options.interlockPhase, 'vacancy', options.interlockDeadline);
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
  const owner = options.owner || {
    ...(options.kind ? { kind: options.kind } : {}),
    pid: process.pid,
    token: randomUUID(),
    timestamp: nowMs,
  };
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
    interlockDeadline: interlockDeadline(),
  };

  try { mkdirSync(dirname(path), { recursive: true }); } catch { return null; }
  while (Date.now() < config.recoveryDeadline) {
    if (hasInFlightFence(path, config)) return null;
    try {
      mkdirSync(path);
      testInterlock('lease-owner-write', 'before', config.interlockDeadline);
      writeFileSync(join(path, ownerFile), JSON.stringify(owner) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      if (hasInFlightFence(path, config)) {
        releaseLease({ path, owner, options: config });
        return null;
      }
      return { path, owner, token: tokenOf(owner), options: config };
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
  return owner !== null && tokenOf(owner) === tokenOf(lease.owner);
}

export function releaseLease(lease) {
  if (!lease?.path || !lease.owner || !leaseOwned(lease)) return false;
  const options = lease.options || {
    ownerFile: 'owner.json',
    readOwner: (path) => readLeaseOwner(path),
    fenceSuffix: '.taken-',
    interlockPhase: 'lease-release',
    releaseInterlockPhase: 'lease-release',
    recoveryDeadline: Date.now() + LEASE_RECOVERY_WAIT_MS,
    interlockDeadline: interlockDeadline(),
  };
  const releaseOptions = { ...options, interlockPhase: options.releaseInterlockPhase || 'lease-release' };
  // The ownership check above is intentionally only a fast-fail guard. The
  // path may change before fencing; the expected owner must remain the lease
  // being released, never a successor snapshot taken from the path.
  testInterlock(releaseOptions.interlockPhase, 'before', releaseOptions.interlockDeadline);
  const expected = { owner: lease.owner, identity: null };
  const fence = takeFence(lease.path, expected, releaseOptions);
  if (!fence.path) return false;
  return removeClaimPath(fence.path, options.ownerFile, options.recoveryDeadline);
}

function pruneQuarantinePath(path) {
  return join(dirname(path), PRUNE_QUARANTINE_DIR, 'victim');
}

// Remove a validated managed file without leaking a new `.prune-*` file on
// every failed attempt.  The displaced inode is restored when possible; if a
// successor occupies the canonical name, it is moved to one deterministic,
// reportable quarantine path.  A later attempt cannot create another slot for
// the same leaf while that recovery entry is present.
export function removePathIfUnchangedRecoverable(path, expectedIdentity, phase = 'lease-remove') {
  if (!isRegularSingleLink(expectedIdentity)) return { ok: false, restored: false, quarantinePath: null };
  const deadline = Date.now() + LEASE_RECOVERY_WAIT_MS;
  testInterlock(phase, 'before', interlockDeadline());
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

export function removePathIfUnchanged(path, expectedIdentity, phase = 'lease-remove') {
  return removePathIfUnchangedRecoverable(path, expectedIdentity, phase).ok;
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

export function leaseFileIdentity(path) {
  return fileIdentity(path);
}
