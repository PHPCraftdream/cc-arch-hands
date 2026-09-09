import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

export function contentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readFileMaybe(path) {
  try {
    return [true, readFileSync(path)];
  } catch (e) {
    if (e.code === 'ENOENT') return [false, null];
    throw e;
  }
}

// Capture a stable leaf snapshot; missing is explicit for create-if-missing CAS.
export function captureRegularFileSnapshot(path) {
  const before = regularFileIdentity(path);
  const [present, content] = readFileMaybe(path);
  const after = regularFileIdentity(path);
  const stable = (before === null && after === null) || sameFileIdentity(before, after);
  if (!stable) {
    throw new Error('managed destination leaf changed concurrently; refusing operation');
  }
  return {
    present,
    content,
    contentDigest: present ? contentDigest(content) : null,
    contentBytes: present ? content.byteLength : 0,
    expectedDestination: after === null
      ? { exists: false, identity: null, mode: null, contentDigest: null, contentBytes: 0 }
      : {
        exists: true,
        identity: after,
        mode: after.mode,
        contentDigest: contentDigest(content),
        contentBytes: content.byteLength,
      },
  };
}

export function regularFileIdentity(path) {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (e) {
    // A concurrent unlink/rename of the exact path can surface as a
    // transient EPERM on Windows (delete-pending) rather than ENOENT --
    // the same tolerance lstatMaybe() in fs-atomic-publication.js already
    // applies for this identical phenomenon. Treated as "not stably
    // present right now", matching ENOENT.
    if (e.code === 'ENOENT' || e.code === 'EPERM') return null;
    throw e;
  }
  if (!info.isFile()) return null;
  return info;
}

// Parent directory identities reject replacement and links.
export function directoryIdentity(path) {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EPERM') return null;
    throw e;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  return { dev: info.dev, ino: info.ino };
}

export function captureDirectoryIdentities(paths) {
  const snapshot = [];
  for (const path of paths) {
    const identity = directoryIdentity(path);
    if (!identity) return null;
    snapshot.push({ path, identity });
  }
  return snapshot;
}

export function sameDirectoryIdentity(left, right) {
  return !!left && !!right
    && sameBigInt(left.dev, right.dev)
    && sameBigInt(left.ino, right.ino);
}

export function directoryIdentitiesMatch(snapshot) {
  return Array.isArray(snapshot)
    && snapshot.every(({ path, identity }) =>
      sameDirectoryIdentity(directoryIdentity(path), identity));
}

export function sameFileIdentity(left, right) {
  if (!left || !right || typeof left.isFile !== 'function'
      || typeof right.isFile !== 'function' || !left.isFile() || !right.isFile()) return false;
  // Include metadata so in-place edits are treated as successors.
  if (!sameBigInt(left.dev, right.dev) || !sameBigInt(left.ino, right.ino)) {
    return false;
  }
  // Exclude ctime: Windows changes it when an inode is moved to quarantine.
  const modeEqual = left.mode === undefined && right.mode === undefined
    ? true
    : sameBigInt(left.mode, right.mode);
  return sameBigInt(left.size, right.size)
    && sameBigInt(left.mtimeNs, right.mtimeNs)
    && modeEqual;
}

// Identities use bigint fields; numeric coercion could collapse distinct inodes.
function sameBigInt(left, right) {
  return typeof left === 'bigint' && typeof right === 'bigint' && left === right;
}

export function sameStatInteger(left, right) {
  return sameBigInt(left, right);
}

export function sameDeviceIdentity(left, right) {
  return !!left && !!right
    && sameBigInt(left.dev, right.dev)
    && sameBigInt(left.ino, right.ino);
}

// Convert mtimeNs to Number only for bounded age/TTL comparisons.
export function mtimeMsForAge(stat) {
  if (!stat || typeof stat.mtimeNs !== 'bigint') return null;
  const milliseconds = stat.mtimeNs / 1_000_000n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const min = -max;
  if (milliseconds < min || milliseconds > max) return null;
  return Number(milliseconds);
}

export function isOlderThan(stat, nowMs, ttlMs) {
  const mtimeMs = mtimeMsForAge(stat);
  return mtimeMs !== null && nowMs >= mtimeMs && nowMs - mtimeMs > ttlMs;
}
