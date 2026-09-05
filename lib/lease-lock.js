// Portable directory leases used by the hooks and the update cache.
//
// Ownership is published only after mkdir wins the race.  Reclamation first
// moves the old claim to a private sibling fence, validates what moved, and
// never restores over a successor.  This is intentionally path based: it is
// the strongest portable primitive available to Node on all supported hosts.

import {
  lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const LEASE_MAX_MS = 5 * 60 * 1000;
export const LEASE_RECOVERY_WAIT_MS = 250;
const TEST_INTERLOCK_TIMEOUT_MS = 10_000;

function sleepSync(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
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
    const info = lstatSync(path);
    return { dev: info.dev, ino: info.ino, isDirectory: info.isDirectory() };
  } catch {
    return null;
  }
}

export function samePathIdentity(left, right) {
  return left !== null && right !== null
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function fileIdentity(path) {
  try {
    const info = statSync(path);
    return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function sameFileIdentity(left, right) {
  return left !== null && right !== null
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function ownerPath(claimPath, ownerFile) {
  try {
    return lstatSync(claimPath).isDirectory() ? join(claimPath, ownerFile) : claimPath;
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
    && sameFileIdentity(expected.identity, fileIdentity(path));
}

function removeClaimPath(path, ownerFile = 'owner.json') {
  try {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      const entries = readdirSync(path);
      if (entries.some((entry) => entry !== ownerFile)) return false;
      if (entries.includes(ownerFile)) unlinkSync(join(path, ownerFile));
      rmdirSync(path);
    } else {
      unlinkSync(path);
    }
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

// Restore by exclusive creation. A successor at `target` is never replaced.
function restoreWithoutOverwrite(source, target, ownerFile = 'owner.json') {
  const sourceIdentity = pathIdentity(source);
  if (!sourceIdentity) return false;
  if (sourceIdentity.isDirectory) {
    let created = false;
    try {
      mkdirSync(target);
      created = true;
      const entries = readdirSync(source);
      if (entries.length > 0) {
        if (entries.length !== 1 || entries[0] !== ownerFile) throw new Error('unexpected lease fence contents');
        renameSync(join(source, ownerFile), join(target, ownerFile));
      }
      rmdirSync(source);
      return true;
    } catch {
      if (created) {
        try { rmdirSync(target); } catch { /* preserve a successor */ }
      }
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
    try { lstatSync(`${readyBase}.go`); return; } catch (error) {
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
      .filter((name) => name.startsWith(prefix) && /^\d+-[^/]+$/.test(name.slice(prefix.length)))
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

function quarantineUnexpectedFence(fencePath, ownerFile) {
  try {
    if (!lstatSync(fencePath).isDirectory()) return false;
    const entries = readdirSync(fencePath);
    if (!entries.some((entry) => entry !== ownerFile)) return false;
    renameSync(fencePath, `${fencePath}.orphan-${process.pid}-${randomUUID()}`);
    return true;
  } catch {
    return false;
  }
}

function recoverFence(path, fencePath, options) {
  const { fenceSuffix, ownerFile, readOwner, maxLeaseMs, nowMs, pidIsAlive } = options;
  const operatorPid = fencePid(path, fencePath, fenceSuffix);
  const fencedIdentity = fileIdentity(fencePath);
  if (!fencedIdentity) return true;
  const fenceExpired = nowMs >= fencedIdentity.mtimeMs && nowMs - fencedIdentity.mtimeMs > maxLeaseMs;
  if (!Number.isInteger(operatorPid) || operatorPid <= 0) return false;
  if (pidIsAlive(operatorPid) && !fenceExpired) return false;
  if (quarantineUnexpectedFence(fencePath, ownerFile)) return true;

  const currentIdentity = fileIdentity(path);
  if (currentIdentity && sameFileIdentity(fencedIdentity, currentIdentity)) {
    return removeClaimPath(fencePath, ownerFile);
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
        ? removeClaimPath(fencePath, ownerFile)
        : false;
    }
    const currentSnapshot = ownerSnapshot(path, readOwner);
    const quarantine = `${path}.abandoned-${process.pid}-${randomUUID()}`;
    try { renameSync(path, quarantine); } catch { return false; }
    if (!sameOwnerSnapshot(quarantine, currentSnapshot, readOwner)) {
      restoreWithoutOverwrite(quarantine, path, ownerFile);
      return false;
    }
    if (!removeClaimPath(quarantine, ownerFile)) return false;
  }
  return restoreWithoutOverwrite(fencePath, path, ownerFile);
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
  return options.nowMs - snapshot.identity.mtimeMs > options.staleAfterMs;
}

function takeFence(path, expected, options) {
  const fencePath = `${path}${options.fenceSuffix}${process.pid}-${randomUUID()}`;
  testInterlock(options.interlockPhase, 'before', options.deadline);
  try { renameSync(path, fencePath); } catch { return null; }
  testInterlock(options.interlockPhase, 'vacancy', options.deadline);
  if (sameOwnerSnapshot(fencePath, expected, options.readOwner)) return { path: fencePath, owner: expected.owner };
  restoreWithoutOverwrite(fencePath, path, options.ownerFile);
  return null;
}

function discardFence(fence) {
  if (!fence) return;
  removeClaimPath(fence.path, fence.ownerFile);
}

export function acquireLease(path, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const testLeaseMs = Number.parseInt(process.env[options.testLeaseEnv || ''] || '', 10);
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
    // Test interlocks deliberately have their own bounded window. The normal
    // lease recovery retry is short, but a multi-process test needs time for
    // the controller to install a successor between the two fence phases.
    deadline: Date.now() + TEST_INTERLOCK_TIMEOUT_MS,
  };

  try { mkdirSync(dirname(path), { recursive: true }); } catch { return null; }
  while (Date.now() < config.deadline) {
    if (hasInFlightFence(path, config)) return null;
    try {
      mkdirSync(path);
      testInterlock('lease-owner-write', 'before', config.deadline);
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
      if (!fence) continue;
      if (hasInFlightFence(path, config, fence.path)) {
        restoreWithoutOverwrite(fence.path, path, ownerFile);
        return null;
      }
      if (!removeClaimPath(fence.path, ownerFile)) return null;
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
    deadline: Date.now() + LEASE_RECOVERY_WAIT_MS,
  };
  const expected = ownerSnapshot(lease.path, options.readOwner);
  const releaseOptions = { ...options, interlockPhase: options.releaseInterlockPhase || 'lease-release' };
  const fence = takeFence(lease.path, expected, releaseOptions);
  if (!fence) return false;
  return removeClaimPath(fence.path, options.ownerFile);
}

export function removePathIfUnchanged(path, expectedIdentity, phase = 'lease-remove') {
  const deadline = Date.now() + LEASE_RECOVERY_WAIT_MS;
  testInterlock(phase, 'before', deadline);
  const fence = `${path}.prune-${process.pid}-${randomUUID()}`;
  try { renameSync(path, fence); } catch { return false; }
  if (!sameFileIdentity(expectedIdentity, fileIdentity(fence))) {
    restoreWithoutOverwrite(fence, path);
    return false;
  }
  try { unlinkSync(fence); return true; } catch { return false; }
}

export function leaseFileIdentity(path) {
  return fileIdentity(path);
}
