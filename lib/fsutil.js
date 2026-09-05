import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
const QUARANTINE_MARKER = '.cah-owned-remove';
const QUARANTINE_CHILD = 'payload';

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
    // Capture the private inode before it is renamed. The canonical entry is
    // checked against this identity after publication; rediscovering the
    // published file from its bytes would mistake a byte-identical successor
    // for the inode this call actually published.
    const tempIdentity = regularFileIdentity(tmp);
    if (!tempIdentity) throw new Error('atomic temp file changed concurrently; refusing operation');
    assertDirectoryIdentities(parentIdentities);
    // The caller may have classified and snapshotted the destination before
    // starting a multi-file publication. Re-check that exact leaf after the
    // temp is complete and immediately before rename so a successor cannot be
    // overwritten. The interlock is test-only and gives race tests a precise
    // point at which to install that successor.
    waitForTestInterlock('write-before-rename');
    assertDirectoryIdentities(parentIdentities);
    assertExpectedDestination(destPath, expectedDestination);
    renameWithRetry(tmp, destPath, expectedDestination, tempIdentity);
    tmp = null;
    waitForTestInterlock('write-after-rename', 'write-post-rename');
    const publishedIdentity = regularFileIdentity(destPath);
    if (!sameFileIdentity(publishedIdentity, tempIdentity)) {
      // Publication already happened. Never attempt to replace or remove the
      // entry now occupying the canonical name: it may be a successor.
      throw new Error('managed destination leaf changed concurrently; refusing operation');
    }
    assertDirectoryIdentities(parentIdentities);
    return {
      path: destPath,
      present: true,
      content: data,
      // Return the identity captured from the private temp. It is the
      // publication's provenance, rather than a fresh content-based lookup
      // of whatever happens to occupy the canonical name later.
      identity: tempIdentity,
      expectedDestination: { exists: true, identity: tempIdentity },
    };
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

function renameWithRetry(from, to, expectedDestination, sourceIdentity) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    // A transient failure can leave time for a foreign successor to appear.
    // Revalidate on every attempt, not just before entering the retry loop.
    assertExpectedDestination(to, expectedDestination);
    if (!sameFileIdentity(regularFileIdentity(from), sourceIdentity)) {
      throw new Error('atomic temp file changed concurrently; refusing operation');
    }
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
// validated inode to one deterministic sibling first, verify that the moved
// entry is still the same regular file, and only then unlink the sibling.
// The slot is deliberately bounded: if it already contains preserved data,
// another removal refuses to move anything into it and reports that path.
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

  // The namespace itself is the collision fence. mkdirSync without
  // recursive mode is an exclusive reservation: if another process (or a
  // user) already owns it, return before even classifying or touching the
  // canonical leaf. In particular, never reclaim a stranded slot merely
  // because its contents happen to carry one of our sentinels.
  const quarantineDir = deterministicQuarantinePath(path);
  let quarantineIdentity;
  try {
    mkdirSync(quarantineDir);
    quarantineIdentity = directoryIdentity(quarantineDir);
    if (!quarantineIdentity) return preservedRemoval(quarantineDir, 'reservation-failed');
  } catch (e) {
    if (e.code === 'EEXIST') return preservedRemoval(existingQuarantinePath(quarantineDir), 'occupied');
    throw e;
  }

  const quarantine = join(quarantineDir, QUARANTINE_CHILD);
  const releaseReservation = () => releaseQuarantineReservation(quarantineDir, quarantineIdentity);
  const current = regularFileIdentity(path);
  if (!sameFileIdentity(current, expected)) {
    if (!releaseReservation()) return preservedRemoval(existingQuarantinePath(quarantineDir), 'reservation-changed');
    return false;
  }

  try {
    const moved = renameForRemoval(path, quarantine, expected, parentIdentities);
    if (moved === 'preserved') return preservedRemoval(existingQuarantinePath(quarantineDir), 'occupied');
    if (!moved) {
      if (!releaseReservation()) return preservedRemoval(existingQuarantinePath(quarantineDir), 'reservation-changed');
      return false;
    }
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      if (!releaseReservation()) return preservedRemoval(existingQuarantinePath(quarantineDir), 'reservation-changed');
      return false;
    }
    if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') {
      return preservedRemoval(existingQuarantinePath(quarantineDir), 'occupied');
    }
    throw e;
  }

  // The test interlock gives a concurrent successor a deterministic chance to
  // occupy the canonical name before we inspect what was moved.
  waitForTestInterlock('remove-after-rename');
  const moved = regularFileIdentity(quarantine);
  if (!sameFileIdentity(moved, expected)) {
    if (parentIdentities === null || directoryIdentitiesMatch(parentIdentities)) {
      restoreWithoutOverwrite(quarantine, path, parentIdentities);
    }
    // If the canonical name is occupied by a successor, restoration cannot
    // use an overwriting rename. Leave the displaced entry in its deterministic
    // reportable quarantine instead of silently dropping foreign data.
    return preservedRemoval(existingQuarantinePath(quarantineDir), 'successor');
  }
  // A parent replacement after the rename must not turn the final unlink or
  // any attempted restore into an operation through a successor link.
  if (parentIdentities !== null && !directoryIdentitiesMatch(parentIdentities)) {
    // The quarantine is deliberately retained. It is the only safe location
    // for the validated inode once its managed parent has been replaced.
    return preservedRemoval(quarantine, 'parent-changed');
  }
  try {
    waitForTestInterlock('remove-before-unlink');
    if (!unlinkExpectedQuarantine(
      quarantine, expected, quarantineDir, quarantineIdentity, parentIdentities,
    )) {
      return preservedRemoval(quarantine, 'quarantine-changed');
    }
  } catch (e) {
    // The identity check above is deliberately repeated by the cleanup
    // helper. If cleanup loses its race, the moved entry remains recoverable.
    restoreWithoutOverwrite(quarantine, path, parentIdentities);
    throw e;
  }
  if (!releaseReservation()) return preservedRemoval(quarantineDir, 'reservation-changed');
  return true;
}

function unlinkExpectedQuarantine(path, expected, quarantineDir, quarantineIdentity, parentIdentities) {
  assertDirectoryIdentities(parentIdentities);
  if (!sameDirectoryIdentity(directoryIdentity(quarantineDir), quarantineIdentity)) return false;
  if (!sameFileIdentity(regularFileIdentity(path), expected)) return false;
  return unlinkForRemoval(path, expected, parentIdentities, quarantineDir, quarantineIdentity);
}

function isTransientFsError(error) {
  return RETRY_CODES.has(error.code);
}

function renameForRemoval(from, to, expected, parentIdentities) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    // A transient rename failure leaves a window in which another writer can
    // replace the source. Revalidate the exact inode before every attempt;
    // otherwise a retry can move a successor into our quarantine.
    assertDirectoryIdentities(parentIdentities);
    if (!sameFileIdentity(regularFileIdentity(from), expected)) return false;
    if (lstatMaybe(to) !== null) return 'preserved';
    waitForTestInterlock('remove-before-rename');
    // The interlock intentionally models the check-to-rename race. If a
    // prior remover installed preserved data in the deterministic slot while
    // we waited, never overwrite that data with another canonical inode.
    if (lstatMaybe(to) !== null) return 'preserved';
    try {
      if (shouldInjectTransientRemovalFailure(attempt)) {
        const injected = new Error('test-only transient removal failure');
        injected.code = 'EPERM';
        throw injected;
      }
      renameSync(from, to);
      return true;
    } catch (e) {
      lastErr = e;
      if (!isTransientFsError(e)) throw e;
      waitForTestInterlock('remove-retry');
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
    }
  }
  throw lastErr;
}

function unlinkForRemoval(path, expected = null, parentIdentities = null,
  quarantineDir = null, quarantineIdentity = null) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertDirectoryIdentities(parentIdentities);
    if (expected !== null && (!sameFileIdentity(regularFileIdentity(path), expected)
        || !sameDirectoryIdentity(directoryIdentity(quarantineDir), quarantineIdentity))) {
      return false;
    }
    try {
      unlinkSync(path);
      return true;
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

function deterministicQuarantinePath(path) {
  return `${path}.cah-owned-remove`;
}

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function existingQuarantinePath(quarantineDir) {
  try {
    const info = lstatSync(quarantineDir);
    if (info.isDirectory()) {
      const child = join(quarantineDir, QUARANTINE_CHILD);
      try {
        lstatSync(child);
        return child;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return quarantineDir;
  } catch (e) {
    if (e.code === 'ENOENT') return quarantineDir;
    throw e;
  }
}

function releaseQuarantineReservation(path, expectedIdentity) {
  const current = directoryIdentity(path);
  if (!sameDirectoryIdentity(current, expectedIdentity)) return false;
  try {
    rmdirSync(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return false;
    throw e;
  }
}

function preservedRemoval(quarantinePath, reason = 'preserved') {
  return {
    removed: false,
    preservedPath: quarantinePath,
    quarantinePath,
    reason,
  };
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

function restoreWithoutOverwrite(from, to, parentIdentities = null) {
  // Restore only with an exclusive copy. Do not rely on hard links, and never
  // remove `from`: it is the preserved foreign inode and remains the recovery
  // record even if the destination copy is later displaced.
  assertDirectoryIdentities(parentIdentities);
  const source = regularFileIdentity(from);
  if (!source) return false;
  const destination = regularFileIdentity(to);
  if (destination) return false;
  try {
    // Re-check both sides immediately before the exclusive copy. The source
    // is never deleted, and COPYFILE_EXCL means a successor can never be
    // overwritten during recovery.
    assertDirectoryIdentities(parentIdentities);
    if (!sameFileIdentity(regularFileIdentity(from), source)
        || regularFileIdentity(to) !== null) return false;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    assertDirectoryIdentities(parentIdentities);
    return true;
  } catch {
    // In particular, EEXIST means a successor occupies `to`; retaining
    // `from` is the only lossless outcome.
    return false;
  }
}

export function waitForTestInterlock(phase) {
  const base = process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK;
  const configured = process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE;
  const phases = configured ? configured.split(',').filter(Boolean) : [];
  if (process.env.CAH_TEST_ONLY !== '1' || !base || !phases.includes(phase)) return;
  const suffix = phases.length > 1 ? `.${phase}` : '';
  writeFileSync(`${base}${suffix}.ready`, 'ready');
  const deadline = Date.now() + 10_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      lstatSync(`${base}${suffix}.go`);
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

// Recovery entries are never installable/orphan leaves. Keep the test for the
// marker deliberately namespace-wide: older releases used a suffixed sibling
// and a preserved file may contain a perfectly valid ownership sentinel.
export function isQuarantineName(name) {
  return String(name).includes(QUARANTINE_MARKER);
}

export function isQuarantinePath(path) {
  return String(path).split(/[\\/]/).some((part) => isQuarantineName(part));
}

export function normalizedRelativePath(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' ? '' : rel.split(sep).join('/');
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
      if (isQuarantineName(entry.name)) continue;
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

export function pruneOrphans(dir, knownNames, sentinelSet, options = {}) {
  let pruned = 0;
  const preserved = [];
  const reportPreserved = (path, result = undefined) => {
    if (!stableExistingPath(path)) return;
    addUnique(preserved, path);
    options.onPreserved?.(path, result);
  };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { pruned, preserved };
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (isQuarantineName(entry.name)) continue;
    if (knownNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const observed = regularFileIdentity(path);
    if (!observed) continue;
    const [present, content] = readFileMaybe(path);
    const afterRead = regularFileIdentity(path);
    if (!sameFileIdentity(observed, afterRead)) {
      // The path may have survived while its inode or metadata changed. It is
      // still an actionable orphan candidate, but only report it after a
      // second identity check proves that the successor is stable.
      reportPreserved(path);
      continue;
    }
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership === Ownership.foreign) {
      reportPreserved(path);
      continue;
    }
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      waitForTestInterlock('prune-before-remove');
      const result = removeOwnedRegularFile(path, afterRead);
      if (result === true) {
        pruned++;
      } else {
        // A false result means the validated orphan changed or disappeared;
        // report a stable successor at the canonical path when one remains.
        // A structured preservation result additionally exposes its bounded
        // quarantine slot, which is itself user-visible recovery data.
        if (result?.reason === 'successor') reportPreserved(path, result);
        if (result?.preservedPath) reportPreserved(result.preservedPath, result);
        if (!result?.preservedPath) reportPreserved(path, result);
      }
    }
  }
  return { pruned, preserved };
}

function stableExistingPath(path) {
  const before = lstatMaybe(path);
  if (before === null) return false;
  const after = lstatMaybe(path);
  if (after === null) return false;
  return before.isFile() && after.isFile()
    ? sameFileIdentity(before, after)
    : before.isDirectory() && after.isDirectory()
      ? sameDirectoryIdentity(before, after)
      : before.dev === after.dev && before.ino === after.ino && before.mode === after.mode;
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
    if (isQuarantineName(entry.name)) continue;
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
    const recoveryEntries = children.filter((child) => isQuarantineName(child.name));
    const recoveryPaths = recoveryEntries.map((child) => relativePreservedPath(
      root, recoveryEntryPath(dirPath, child),
    ));
    const managedChildren = children.filter((child) => !isQuarantineName(child.name));
    const manifestEntry = managedChildren.find((child) => child.name === manifestLeaf);
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
    for (const recoveryPath of recoveryPaths) addUnique(preserved, recoveryPath);
    if (managedChildren.length !== 1) {
      addUnique(preserved, entry.name);
      continue;
    }
    // Close the widest practical race before removing the manifest: if any
    // entry appeared or the manifest changed type, preserve the directory.
    const current = readdirSync(dirPath, { withFileTypes: true });
    const currentManaged = current.filter((child) => !isQuarantineName(child.name));
    if (currentManaged.length !== 1
        || currentManaged[0].name !== manifestLeaf
        || !currentManaged[0].isFile()) {
      addUnique(preserved, entry.name);
      continue;
    }
    const finalManifest = regularFileIdentity(manifestPath);
    if (!sameFileIdentity(finalManifest, manifestAfter)) {
      addUnique(preserved, entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-manifest-remove');
    const removal = removeOwnedRegularFile(manifestPath, manifestAfter);
    if (removal !== true) {
      addUnique(preserved, entry.name);
      if (removal?.preservedPath) {
        addUnique(preserved, relativePreservedPath(root, removal.preservedPath));
      }
      continue;
    }
    waitForTestInterlock('prune-before-rmdir');
    if (removeEmptyDirectory(dirPath)) pruned++;
    else addUnique(preserved, entry.name);
  }
  return { pruned, preserved };
}

function relativePreservedPath(root, path) {
  const rootAbs = resolve(root);
  const pathAbs = resolve(path);
  const rel = pathAbs.startsWith(`${rootAbs}${sep}`) ? pathAbs.slice(rootAbs.length + 1) : pathAbs;
  return rel.replaceAll(sep, '/');
}

function recoveryEntryPath(dirPath, entry) {
  const path = join(dirPath, entry.name);
  if (!entry.isDirectory()) return path;
  const child = join(path, QUARANTINE_CHILD);
  return lstatMaybe(child) === null ? path : child;
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}
