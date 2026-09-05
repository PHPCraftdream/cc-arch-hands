import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';

// Write `payload` to `destPath` via an exclusively-created, unpredictable
// sibling temp + rename so an interrupted or failed write never exposes a
// half-written destination. This matters for files whose ownership sentinel
// sits at the end of the body: a torn write would drop the sentinel and get
// the file misclassified as foreign (and thus stuck).
//
// The rename is retried for transient OS errors: on Windows, antivirus tools
// and the search indexer briefly lock a freshly-written file, so an immediate
// rename-over-existing can fail with EPERM/EBUSY/ENOTEMPTY/EACCES even though
// nothing is wrong. A short bounded retry with backoff clears the race.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_RETRIES = 5;
const RENAME_BASE_MS = 20;
const TEMP_CREATE_RETRIES = 10;
const TEMP_RANDOM_BYTES = 16;

/**
 * Atomically publish a file.
 *
 * `options.parentIdentities` is an optional snapshot from
 * captureDirectoryIdentities(). When supplied, parent creation is disabled
 * unless explicitly requested and the complete managed parent chain is
 * checked before opening the temp file, before publication, and afterwards.
 * This is a portable path-based race check, not an OS security boundary:
 * callers must not concurrently replace the checked directories between the
 * final check and the filesystem operation (Node core has no openat-style
 * anchored primitive on every supported platform).
 */
export function writeFileAtomic(destPath, payload, options = {}) {
  const { parentIdentities = null } = options;
  const expectedDestination = options.expectedDestination;
  const mode = options.mode;
  const priorMode = mode === undefined ? existingRegularFileMode(destPath) : null;
  const tempMode = mode ?? priorMode ?? 0o666;
  const createParents = options.createParents ?? parentIdentities === null;
  if (createParents) mkdirSync(dirname(destPath), { recursive: true });
  assertDirectoryIdentities(parentIdentities);
  const data = toBuffer(payload);
  let tmp = null;
  let fd = null;
  try {
    ({ path: tmp, fd } = openUniqueSiblingTemp(destPath, tempMode));
    assertDirectoryIdentities(parentIdentities);
    writeAll(fd, data);
    // Apply an explicitly requested mode to the private temp entry. The
    // canonical destination is never chmod'ed after publication, so a
    // concurrent successor cannot have its permissions changed by us.
    if (mode !== undefined || priorMode !== null) chmodSync(tmp, tempMode);
    closeSync(fd);
    fd = null;
    assertDirectoryIdentities(parentIdentities);
    // The caller may have classified and snapshotted the destination before
    // starting a multi-file publication. Re-check that exact leaf after the
    // temp is complete and immediately before rename so a successor cannot be
    // overwritten. The interlock is test-only and gives race tests a precise
    // point at which to install that successor.
    waitForTestInterlock('write-before-rename');
    assertDirectoryIdentities(parentIdentities);
    assertExpectedDestination(destPath, expectedDestination);
    renameWithRetry(tmp, destPath, expectedDestination);
    tmp = null;
    assertDirectoryIdentities(parentIdentities);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // preserve the original write/open/rename failure
      }
    }
    // Don't strand a half-written temp file (it would later be mistaken for a
    // user file inside a skill dir). Best-effort cleanup, then rethrow.
    try {
      if (tmp !== null) unlinkSync(tmp);
    } catch {
      // ignore — nothing more we can do
    }
    throw e;
  }
}

function assertExpectedDestination(path, expected) {
  if (expected === undefined) return;
  let current;
  try {
    current = lstatSync(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    current = null;
  }

  const expectedExists = expected !== null && (expected.exists ?? expected.present);
  const matches = expectedExists
    ? sameFileIdentity(current, expected.identity)
    : current === null;
  if (!matches) {
    throw new Error('managed destination leaf changed concurrently; refusing operation');
  }
}

function toBuffer(payload) {
  if (typeof payload === 'string') return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return payload;
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError('writeFileAtomic: payload must be a string, Buffer, or ArrayBuffer view');
}

function openUniqueSiblingTemp(destPath, mode = 0o666) {
  const dir = dirname(destPath);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  let lastCollision = null;
  for (let attempt = 0; attempt < TEMP_CREATE_RETRIES; attempt++) {
    const token = randomBytes(TEMP_RANDOM_BYTES).toString('hex');
    const path = join(dir, `.cah-tmp-${process.pid}-${token}`);
    try {
      const fd = openSync(path, flags, mode);
      return { path, fd };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      lastCollision = e;
    }
  }
  throw lastCollision || new Error(`could not create unique atomic temp for ${destPath}`);
}

function existingRegularFileMode(path) {
  try {
    const info = lstatSync(path);
    return info.isFile() ? (info.mode & 0o7777) : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset);
    if (written === 0) throw new Error('writeFileAtomic: zero-byte write');
    offset += written;
  }
}

function renameWithRetry(from, to, expectedDestination) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    // A transient failure can leave time for a foreign successor to appear.
    // Revalidate on every attempt, not just before entering the retry loop.
    assertExpectedDestination(to, expectedDestination);
    try {
      if (shouldInjectTransientRenameFailure(attempt)) {
        const injected = new Error('test-only transient rename failure');
        injected.code = 'EPERM';
        throw injected;
      }
      renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code)) throw e;
      waitForTestInterlock('rename-retry');
      // Exponential-ish backoff: 20, 40, 80, 160, 320 ms (cap).
      const delay = RENAME_BASE_MS * (1 << Math.min(attempt, 4));
      sleepSync(delay);
    }
  }
  throw lastErr;
}

function shouldInjectTransientRenameFailure(attempt) {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const raw = process.env.CAH_TEST_ONLY_FSUTIL_RENAME_TRANSIENT_FAILURES;
  if (raw === undefined) return false;
  const count = Number.parseInt(raw, 10);
  return Number.isSafeInteger(count) && count > attempt;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — keeps this sync and zero-dep */ }
}

export function readFileMaybe(path) {
  try {
    return [true, readFileSync(path)];
  } catch (e) {
    if (e.code === 'ENOENT') return [false, null];
    throw e;
  }
}

// Read and classify callers need a stable leaf snapshot around the read. A
// missing leaf is represented explicitly so expectedDestination can also
// protect the create-if-missing case from a concurrent successor.
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
    expectedDestination: after === null
      ? { exists: false, identity: null }
      : { exists: true, identity: after },
  };
}

// A path-based unlink has no conditional form: after a caller validates a
// file, another process can replace it before unlinkSync runs. Move the
// validated inode to an unpredictable sibling first, verify that the moved
// entry is still the same regular file, and only then unlink the sibling.
// A replacement is restored with a non-overwriting hard link where possible;
// if that is unavailable, leaving the unpredictable sibling is safer than
// risking an overwrite of a user's successor.
export function regularFileIdentity(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (!info.isFile()) return null;
  return info;
}

// Directory dev+ino is stable across ordinary writes and changes when a
// parent is replaced. lstat-based lookup deliberately rejects links: a link
// is never an acceptable managed parent identity.
export function directoryIdentity(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
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
  return left !== null && right !== null
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

export function directoryIdentitiesMatch(snapshot) {
  return Array.isArray(snapshot)
    && snapshot.every(({ path, identity }) =>
      sameDirectoryIdentity(directoryIdentity(path), identity));
}

function assertDirectoryIdentities(snapshot) {
  if (snapshot !== null && !directoryIdentitiesMatch(snapshot)) {
    throw new Error('managed destination parent changed concurrently; refusing operation');
  }
}

export function sameFileIdentity(left, right) {
  if (!left || !right || !left.isFile() || !right.isFile()) return false;
  // dev/ino identify the directory entry's inode. Include metadata that
  // changes for an in-place replacement so an edited managed file is also
  // treated as a successor when the filesystem exposes nanosecond timestamps.
  if (String(left.dev) !== String(right.dev) || String(left.ino) !== String(right.ino)) {
    return false;
  }
  // ctime is intentionally excluded: Windows updates it when the same inode
  // is moved to the quarantine name. mtime/size still catch ordinary
  // in-place edits, while dev/ino catch replacement files.
  return left.size === right.size
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

export function removeOwnedRegularFile(path, expected, options = {}) {
  const { parentIdentities = null } = options;
  assertDirectoryIdentities(parentIdentities);
  const current = regularFileIdentity(path);
  if (!sameFileIdentity(current, expected)) return false;

  const quarantine = uniqueSibling(path, '.cah-owned-remove-');
  try {
    renameForRemoval(path, quarantine);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }

  const moved = regularFileIdentity(quarantine);
  if (!sameFileIdentity(moved, expected)) {
    if (parentIdentities === null || directoryIdentitiesMatch(parentIdentities)) {
      restoreWithoutOverwrite(quarantine, path);
    } else {
      discardQuarantine(quarantine);
    }
    return false;
  }
  // A parent replacement after the rename must not turn the final unlink or
  // any attempted restore into an operation through a successor link.
  if (parentIdentities !== null && !directoryIdentitiesMatch(parentIdentities)) {
    discardQuarantine(quarantine);
    return false;
  }
  try {
    unlinkForRemoval(quarantine);
  } catch (e) {
    restoreWithoutOverwrite(quarantine, path);
    throw e;
  }
  return true;
}

function discardQuarantine(path) {
  try {
    unlinkForRemoval(path);
  } catch {
    // Removal is best effort after a parent identity failure; never follow or
    // repair through the replacement parent just to clean the old entry.
  }
}

function isTransientFsError(error) {
  return RETRY_CODES.has(error.code);
}

function renameForRemoval(from, to) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      if (shouldInjectTransientRemovalFailure(attempt)) {
        const injected = new Error('test-only transient removal failure');
        injected.code = 'EPERM';
        throw injected;
      }
      renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!isTransientFsError(e)) throw e;
      waitForTestInterlock('remove-retry');
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
    }
  }
  throw lastErr;
}

function unlinkForRemoval(path) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      unlinkSync(path);
      return;
    } catch (e) {
      lastErr = e;
      if (!isTransientFsError(e)) throw e;
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
    }
  }
  throw lastErr;
}

function shouldInjectTransientRemovalFailure(attempt) {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const raw = process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES;
  if (raw === undefined) return false;
  const count = Number.parseInt(raw, 10);
  return Number.isSafeInteger(count) && count > attempt;
}

export function removeEmptyDirectory(path, options = {}) {
  const { parentIdentities = null } = options;
  assertDirectoryIdentities(parentIdentities);
  try {
    rmdirSync(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST'
        || e.code === 'ENOTDIR' || e.code === 'EBUSY'
        || e.code === 'EPERM' || e.code === 'EACCES') return false;
    throw e;
  }
}

function uniqueSibling(path, prefix) {
  const dir = dirname(path);
  for (let attempt = 0; attempt < TEMP_CREATE_RETRIES; attempt++) {
    const candidate = join(dir, `${prefix}${process.pid}-${randomBytes(TEMP_RANDOM_BYTES).toString('hex')}`);
    try {
      lstatSync(candidate);
    } catch (e) {
      if (e.code === 'ENOENT') return candidate;
      throw e;
    }
  }
  throw new Error(`could not create unique removal name for ${path}`);
}

function restoreWithoutOverwrite(from, to) {
  // Prefer a hard link where available, but fall back to an exclusive copy for
  // exFAT/SMB and other filesystems without hard-link support. If a successor
  // already occupies the target, the managed file is intentionally discarded
  // and the quarantine is cleaned; never overwrite the successor or strand a
  // private quarantine entry.
  try {
    linkSync(from, to);
    unlinkSync(from);
    return true;
  } catch (linkError) {
    try {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      unlinkSync(from);
      return true;
    } catch (copyError) {
      try {
        unlinkSync(from);
      } catch {
        // Best effort: the source may already have been cleaned by a racer.
      }
      if (copyError.code === 'EEXIST' || linkError.code === 'EEXIST') return false;
      return false;
    }
  }
}

export function waitForTestInterlock(phase) {
  const base = process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK;
  if (process.env.CAH_TEST_ONLY !== '1'
      || !base || process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE !== phase) return;
  writeFileSync(`${base}.ready`, 'ready');
  const deadline = Date.now() + 10_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      lstatSync(`${base}.go`);
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`test interlock timed out for ${phase}`);
      }
      Atomics.wait(signal, 0, 0, Math.min(remaining, 50));
    }
  }
}

// List every regular file under `dir`, returned as paths relative to `dir`
// with '/' separators on all platforms. Returns [] if the directory is
// missing. Used to tell "files cah wrote" apart from files a user dropped
// into (or copied alongside) a skill directory.
export function listFilesRel(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out;
}

export function pruneOrphans(dir, knownNames, sentinelSet) {
  let pruned = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (knownNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const observed = regularFileIdentity(path);
    if (!observed) continue;
    const [present, content] = readFileMaybe(path);
    const afterRead = regularFileIdentity(path);
    if (!sameFileIdentity(observed, afterRead)) continue;
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      waitForTestInterlock('prune-before-remove');
      if (removeOwnedRegularFile(path, afterRead)) pruned++;
    }
  }
  return pruned;
}

// Prune directories under `root` whose name is no longer in `knownNames` but
// whose manifest leaf carries one of our sentinels. Returns
// { pruned, preserved } — `preserved` lists orphan dirs that were NOT deleted
// because they hold files beyond the owned manifest (e.g. a user copied an
// installed skill as a starting point and added their own files; wiping the
// whole tree would silently destroy that data).
export function pruneOrphanDirs(root, knownNames, manifestLeaf, sentinelSet) {
  let pruned = 0;
  const preserved = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { pruned, preserved };
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (knownNames.has(entry.name)) continue;
    const dirPath = join(root, entry.name);
    let children;
    try {
      children = readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    // Never resolve a link at the ownership marker path. Only a regular file
    // named exactly `manifestLeaf` can make this directory pruneable.
    const manifestEntry = children.find((child) => child.name === manifestLeaf);
    if (!manifestEntry || !manifestEntry.isFile()) continue;
    const manifestPath = join(dirPath, manifestLeaf);
    const manifestBefore = regularFileIdentity(manifestPath);
    if (!manifestBefore) continue;
    const [present, content] = readFileMaybe(manifestPath);
    const manifestAfter = regularFileIdentity(manifestPath);
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership !== Ownership.mine && ownership !== Ownership.legacy) continue;
    if (!sameFileIdentity(manifestBefore, manifestAfter)) continue;

    // Inspect only direct entries. Anything besides the one owned regular
    // manifest is user data, including links/junctions, empty directories,
    // sockets, and other special entries. Do not descend into or follow it.
    if (children.length !== 1) {
      preserved.push(entry.name);
      continue;
    }
    // Close the widest practical race before removing the manifest: if any
    // entry appeared or the manifest changed type, preserve the directory.
    const current = readdirSync(dirPath, { withFileTypes: true });
    if (current.length !== 1
        || current[0].name !== manifestLeaf
        || !current[0].isFile()) {
      preserved.push(entry.name);
      continue;
    }
    const finalManifest = regularFileIdentity(manifestPath);
    if (!sameFileIdentity(finalManifest, manifestAfter)) {
      preserved.push(entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-manifest-remove');
    if (!removeOwnedRegularFile(manifestPath, manifestAfter)) {
      preserved.push(entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-rmdir');
    if (removeEmptyDirectory(dirPath)) pruned++;
    else preserved.push(entry.name);
  }
  return { pruned, preserved };
}
