import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const INSPECTION_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const INSPECTION_RETRIES = 3;

export class AtomicInspectionError extends Error {
  constructor(path, cause) {
    super(`cannot inspect managed filesystem entry; refusing operation: ${path}`, { cause });
    this.name = 'AtomicInspectionError';
    this.code = 'ERR_ATOMIC_INSPECTION_FAILED';
    this.path = path;
  }
}

// Unknown metadata is never evidence that a path is absent.
function inspectMaybe(path, read) {
  for (let attempt = 0; ; attempt++) {
    try {
      return read();
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (!INSPECTION_RETRY_CODES.has(error.code)) throw error;
      if (attempt === INSPECTION_RETRIES) throw new AtomicInspectionError(path, error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (2 ** attempt));
    }
  }
}

export function lstatMaybe(path) {
  return inspectMaybe(path, () => lstatSync(path, { bigint: true }));
}

export function contentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readFileMaybe(path) {
  const content = inspectMaybe(path, () => readFileSync(path));
  return content === null ? [false, null] : [true, content];
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
  const info = lstatMaybe(path);
  if (!info?.isFile()) return null;
  return info;
}

// Parent directory identities reject replacement and links.
export function directoryIdentity(path) {
  const info = lstatMaybe(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
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
