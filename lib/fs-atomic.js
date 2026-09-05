import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';


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
const PUBLICATION_FENCE_SUFFIX = '.cah-owned-publish';
const PUBLICATION_FENCE_CHILD = 'old';
const RECOVERY_MARKERS = [QUARANTINE_MARKER, PUBLICATION_FENCE_SUFFIX, '.cah-tmp-'];

function contentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

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
  let fence = null;
  let published = false;
  let destinationChanged = false;
  let tempSnapshot = null;
  let publicationIdentity = null;
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
    tempSnapshot = captureRegularFileSnapshot(tmp);
    if (!tempSnapshot.present) throw new Error('atomic temp file changed concurrently; refusing operation');
    assertDirectoryIdentities(parentIdentities);
    // The caller may have classified and snapshotted the destination before
    // starting a multi-file publication. Re-check that exact leaf after the
    // temp is complete and immediately before rename so a successor cannot be
    // overwritten. The interlock is test-only and gives race tests a precise
    // point at which to install that successor.
    if (expectedDestination === undefined) {
      waitForTestInterlock('write-before-rename');
      renameWithRetry(
        tmp, destPath, undefined, tempSnapshot.expectedDestination.identity, tempSnapshot.contentDigest,
      );
      tmp = null;
      publicationIdentity = tempSnapshot.expectedDestination.identity;
    } else {
      // Compatibility interlock: callers historically use this point to
      // replace the checked leaf before the conditional move. The actual
      // vacancy race is fenced by the later final-publication interlock.
      waitForTestInterlock('rename-retry');
      waitForTestInterlock('write-before-rename');
      const expected = normalizeExpectedDestination(expectedDestination);
      if (expected.exists) {
        fence = reservePublicationFence(destPath);
        fence.oldSnapshot = moveExpectedToFence(destPath, fence.oldPath, expected, parentIdentities);
      } else {
        assertExpectedDestination(destPath, expected);
      }
      // Immediately before the no-clobber operation: a successor appearing
      // while the name is vacant is rejected by the filesystem primitive.
      if (options.testInterlockPhase) {
        waitForTestInterlock(options.testInterlockPhase);
      } else {
        waitForTestInterlock('write-before-final-publication');
        waitForTestInterlock('write-before-final-operation');
      }
      assertDirectoryIdentities(parentIdentities);
      try {
        const publication = publishWithoutOverwrite(tmp, destPath, tempSnapshot, parentIdentities);
        publicationIdentity = publication.expectedDestination.identity;
        published = true;
        tmp = null;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          destinationChanged = true;
          const conflict = new Error('managed destination leaf changed concurrently; refusing operation');
          conflict.code = 'EEXIST';
          throw conflict;
        }
        throw error;
      }
      waitForTestInterlock('write-after-rename', 'write-post-rename');
    }
    const publishedSnapshot = captureRegularFileSnapshot(destPath);
    if (!publishedSnapshot.present
        || !sameFileIdentity(publishedSnapshot.expectedDestination.identity, publicationIdentity)
        || publishedSnapshot.contentDigest !== tempSnapshot.contentDigest) {
      throw new Error('managed destination leaf changed concurrently; refusing operation');
    }
    assertDirectoryIdentities(parentIdentities);
    if (fence) finishPublicationFence(fence, expectedDestination);
    return {
      path: destPath,
      present: true,
      content: data,
      contentDigest: contentDigest(data),
      contentBytes: data.byteLength,
      // Return the exact BigInt identity observed at the canonical leaf after
      // publication, together with its digest for a later conditional CAS.
      identity: publishedSnapshot.expectedDestination.identity,
      expectedDestination: publishedSnapshot.expectedDestination,
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
    if (fence && !published && !destinationChanged) {
      try { restoreWithoutOverwrite(fence.oldPath, destPath, parentIdentities); } catch { /* preserve fence */ }
    }
    if (tmp !== null && !destinationChanged) {
      try {
        if (sameFileIdentity(regularFileIdentity(tmp), tempSnapshot?.expectedDestination?.identity)) {
          unlinkSync(tmp);
        }
      } catch {
        // preserve the original error
      }
    }
    if (fence && !published && !destinationChanged) removeEmptyPublicationFence(fence);
    throw e;
  }
}

function assertExpectedDestination(path, expected) {
  if (expected === undefined) return;
  const normalized = normalizeExpectedDestination(expected);
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    current = null;
  }

  const expectedExists = normalized.exists;
  const matches = expectedExists
    ? current !== null && sameFileIdentity(current, normalized.identity)
    : current === null;
  if (!matches) {
    throw new Error('managed destination leaf changed concurrently; refusing operation');
  }
  if (expectedExists && normalized.contentDigest !== null) {
    const snapshot = captureRegularFileSnapshot(path);
    if (snapshot.contentDigest !== normalized.contentDigest
        || snapshot.contentBytes !== normalized.contentBytes) {
      throw new Error('managed destination leaf changed concurrently; refusing operation');
    }
  }
}

function normalizeExpectedDestination(expected) {
  if (expected === null || expected === undefined) {
    return { exists: false, identity: null, contentDigest: null, contentBytes: 0 };
  }
  if (expected.exists !== undefined || expected.present !== undefined) {
    return {
      exists: Boolean(expected.exists ?? expected.present),
      identity: expected.identity ?? null,
      contentDigest: expected.contentDigest ?? null,
      contentBytes: expected.contentBytes ?? null,
    };
  }
  return { exists: true, identity: expected, contentDigest: null, contentBytes: null };
}

function reservePublicationFence(path) {
  const root = `${path}${PUBLICATION_FENCE_SUFFIX}`;
  try {
    mkdirSync(root);
  } catch (e) {
    if (e.code === 'EEXIST') {
      const error = new Error('managed publication fence is occupied; refusing operation');
      error.code = 'EEXIST';
      throw error;
    }
    throw e;
  }
  return { root, oldPath: join(root, PUBLICATION_FENCE_CHILD), oldSnapshot: null };
}

function assertExpectedSnapshot(snapshot, expected) {
  if (!snapshot.present || !sameFileIdentity(snapshot.expectedDestination.identity, expected.identity)
      || (expected.contentDigest !== null && snapshot.contentDigest !== expected.contentDigest)
      || (expected.contentBytes !== null && snapshot.contentBytes !== expected.contentBytes)) {
    throw new Error('managed destination leaf changed concurrently; refusing operation');
  }
}

function moveExpectedToFence(path, fencePath, expected, parentIdentities) {
  const current = captureRegularFileSnapshot(path);
  const effective = expected.contentDigest === null
    ? { ...expected, contentDigest: current.contentDigest, contentBytes: current.contentBytes }
    : expected;
  assertExpectedSnapshot(current, effective);
  assertDirectoryIdentities(parentIdentities);
  try {
    renameSync(path, fencePath);
  } catch (e) {
    if (!RETRY_CODES.has(e.code)) throw e;
    assertExpectedDestination(path, effective);
    renameSync(path, fencePath);
  }
  const moved = captureRegularFileSnapshot(fencePath);
  if (!moved.present || !sameFileIdentity(moved.expectedDestination.identity, effective.identity)
      || moved.contentDigest !== effective.contentDigest
      || moved.contentBytes !== effective.contentBytes) {
    restoreWithoutOverwrite(fencePath, path, parentIdentities);
    throw new Error('managed destination leaf changed concurrently; refusing operation');
  }
  return moved;
}

function publishWithoutOverwrite(from, to, sourceSnapshot, parentIdentities) {
  assertDirectoryIdentities(parentIdentities);
  const source = captureRegularFileSnapshot(from);
  assertExpectedSnapshot(source, {
    exists: true,
    identity: sourceSnapshot.expectedDestination.identity,
    contentDigest: sourceSnapshot.contentDigest,
    contentBytes: sourceSnapshot.contentBytes,
  });
  try {
    // Hard-link creation is atomic and exclusive where supported.
    linkSync(from, to);
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    if (!['EXDEV', 'EPERM', 'EACCES', 'EOPNOTSUPP', 'ENOSYS', 'ENOTSUP'].includes(e.code)) {
      throw e;
    }
    // COPYFILE_EXCL is the portable no-clobber fallback. Its destination can
    // be visible during the copy; the hard-link path retains atomic visibility.
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
  const published = captureRegularFileSnapshot(to);
  if (!published.present || published.contentDigest !== sourceSnapshot.contentDigest
      || published.contentBytes !== sourceSnapshot.contentBytes) {
    throw new Error('managed destination leaf changed concurrently; refusing operation');
  }
  if (sameFileIdentity(regularFileIdentity(from), sourceSnapshot.expectedDestination.identity)) {
    try { unlinkSync(from); } catch { /* publication is already complete */ }
  }
  return published;
}

function finishPublicationFence(fence, expectedDestination) {
  const old = captureRegularFileSnapshot(fence.oldPath);
  const expected = normalizeExpectedDestination(expectedDestination);
  if (old.present && fence.oldSnapshot
      && sameFileIdentity(old.expectedDestination.identity, fence.oldSnapshot.expectedDestination.identity)
      && old.contentDigest === fence.oldSnapshot.contentDigest
      && (expected.contentDigest === null || old.contentDigest === expected.contentDigest)) {
    try { unlinkSync(fence.oldPath); } catch { return; }
  }
  removeEmptyPublicationFence(fence);
}

function removeEmptyPublicationFence(fence) {
  try { rmdirSync(fence.root); } catch { /* a preserved old inode remains recoverable */ }
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
    const info = lstatSync(path, { bigint: true });
    return info.isFile() ? Number(info.mode & 0o7777n) : null;
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
  while (Date.now() < end) { /* busy wait â€” keeps this sync and zero-dep */ }
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
    contentDigest: present ? contentDigest(content) : null,
    contentBytes: present ? content.byteLength : 0,
    expectedDestination: after === null
      ? { exists: false, identity: null, contentDigest: null, contentBytes: 0 }
      : { exists: true, identity: after, contentDigest: contentDigest(content), contentBytes: content.byteLength },
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
    info = lstatSync(path, { bigint: true });
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
    info = lstatSync(path, { bigint: true });
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
  return !!left && !!right
    && sameBigInt(left.dev, right.dev)
    && sameBigInt(left.ino, right.ino);
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
  if (!sameBigInt(left.dev, right.dev) || !sameBigInt(left.ino, right.ino)) {
    return false;
  }
  // ctime is intentionally excluded: Windows updates it when the same inode
  // is moved to the quarantine name. mtime/size still catch ordinary
  // in-place edits, while dev/ino catch replacement files.
  return sameBigInt(left.size, right.size)
    && sameBigInt(left.mtimeNs, right.mtimeNs);
}

// All filesystem identities are captured with `{ bigint: true }`. Refuse
// numeric fields here: converting a large dev/ino/size would make two
// distinct inodes compare equal after Number rounding.
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

// `mtimeNs` remains an identity field. This conversion is intentionally
// isolated for age/TTL comparisons, where the result is required to be a
// safe millisecond Number rather than an exact filesystem identity.
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
  const currentSnapshot = captureRegularFileSnapshot(path);
  const expectedInfo = normalizeExpectedDestination(expected);
  const effectiveExpected = expectedInfo.contentDigest === null && currentSnapshot.present
    ? { ...expectedInfo, contentDigest: currentSnapshot.contentDigest, contentBytes: currentSnapshot.contentBytes }
    : expectedInfo;
  if (!currentSnapshot.present || !sameFileIdentity(
    currentSnapshot.expectedDestination.identity, effectiveExpected.identity,
  )) {
    if (!releaseReservation()) return preservedRemoval(existingQuarantinePath(quarantineDir), 'reservation-changed');
    return false;
  }

  try {
    const moved = renameForRemoval(path, quarantine, effectiveExpected.identity, parentIdentities);
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
  const movedSnapshot = captureRegularFileSnapshot(quarantine);
  if (!movedSnapshot.present
      || !sameFileIdentity(movedSnapshot.expectedDestination.identity, effectiveExpected.identity)
      || movedSnapshot.contentDigest !== effectiveExpected.contentDigest
      || movedSnapshot.contentBytes !== effectiveExpected.contentBytes) {
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
      quarantine, effectiveExpected.identity, quarantineDir, quarantineIdentity, parentIdentities,
      effectiveExpected.contentDigest,
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

function unlinkExpectedQuarantine(
  path, expected, quarantineDir, quarantineIdentity, parentIdentities, expectedDigest = null,
) {
  assertDirectoryIdentities(parentIdentities);
  if (!sameDirectoryIdentity(directoryIdentity(quarantineDir), quarantineIdentity)) return false;
  if (!sameFileIdentity(regularFileIdentity(path), expected)) return false;
  const snapshot = captureRegularFileSnapshot(path);
  if (!snapshot.present || (expectedDigest !== null && snapshot.contentDigest !== expectedDigest)) {
    return false;
  }
  return unlinkForRemoval(
    path, expected, parentIdentities, quarantineDir, quarantineIdentity, expectedDigest,
  );
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
  quarantineDir = null, quarantineIdentity = null, expectedDigest = null) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertDirectoryIdentities(parentIdentities);
    if (expected !== null && (!sameFileIdentity(regularFileIdentity(path), expected)
        || !sameDirectoryIdentity(directoryIdentity(quarantineDir), quarantineIdentity))) {
      return false;
    }
    if (expectedDigest !== null) {
      const snapshot = captureRegularFileSnapshot(path);
      if (!snapshot.present || snapshot.contentDigest !== expectedDigest) return false;
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
    return lstatSync(path, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function existingQuarantinePath(quarantineDir) {
  try {
    const info = lstatSync(quarantineDir, { bigint: true });
    if (info.isDirectory()) {
      const child = join(quarantineDir, QUARANTINE_CHILD);
      try {
        lstatSync(child, { bigint: true });
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
      lstatSync(candidate, { bigint: true });
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
      lstatSync(`${base}${suffix}.go`, { bigint: true });
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
  const value = String(name);
  return RECOVERY_MARKERS.some((marker) => value.includes(marker));
}

export function isQuarantinePath(path) {
  return String(path).split(/[\\/]/).some((part) => isQuarantineName(part));
}

