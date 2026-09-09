import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  renameSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  contentDigest, captureRegularFileSnapshot, regularFileIdentity, directoryIdentity,
  sameDirectoryIdentity, directoryIdentitiesMatch,
  sameFileIdentity, sameStatInteger, isOlderThan,
} from './fs-atomic-identity.js';
import {
  AtomicOwnershipLostError, FENCE_STALE_MS, publishWithFence, PUBLICATION_FENCE_SUFFIX,
  PUBLICATION_PROOF_FILE, readPublicationProof, recoverPublicationFence,
  syncDirectory,
} from './fs-atomic-publication.js';

export { AtomicOwnershipLostError };

export { syncDirectory } from './fs-atomic-publication.js';

export {
  readFileMaybe, captureRegularFileSnapshot, regularFileIdentity, directoryIdentity,
  captureDirectoryIdentities, sameDirectoryIdentity, directoryIdentitiesMatch,
  sameFileIdentity, sameStatInteger, sameDeviceIdentity, mtimeMsForAge, isOlderThan,
} from './fs-atomic-identity.js';


// Publish through a private sibling temp and bounded same-directory rename.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const RENAME_RETRIES = 5;
const RENAME_BASE_MS = 20;
const TEMP_CREATE_RETRIES = 10;
const TEMP_RANDOM_BYTES = 16;
const QUARANTINE_MARKER = '.cah-owned-remove';
const QUARANTINE_CHILD = 'payload';
const PUBLICATION_FENCE_CHILD = 'old';
// Mirrors LEASE_QUARANTINE_DIR, the recoverFence() displacement marker and
// PRUNE_QUARANTINE_DIR in lib/lease-lock.js. Hardcoded (not imported) so the
// mirrored companion-runtime import graph stays unchanged.
const LEASE_QUARANTINE_DIR = '.cah-lease-quarantine';
// Displacement quarantines recoverFence() can leave behind when restoring an
// old fence loses to a successor: `<lease>.abandoned-<pid>-<uuid>`.
const LEASE_ABANDONED_MARKER = '.abandoned-';
// The deterministic capacity-eviction victim slot: `.cah-capacity-quarantine`.
const CAPACITY_QUARANTINE_DIR = '.cah-capacity-quarantine';
// Every namespace belongs here so isQuarantineName() and
// describeRecoveryArtifact() agree on what the string means, and so no
// recovery namespace the product creates is invisible to the sweep report.
const RECOVERY_MARKERS = [QUARANTINE_MARKER, PUBLICATION_FENCE_SUFFIX, '.cah-tmp-',
  LEASE_QUARANTINE_DIR, LEASE_ABANDONED_MARKER, CAPACITY_QUARANTINE_DIR];
const RECOVERY_LIMIT = 128;
const RECOVERY_SWEEP_LIMIT = 32;
const RECOVERY_VISIT_LIMIT = 128;
const RECOVERY_DISPLACED_VISIT_LIMIT = 2048;
// removeOwnedRegularFile() reserves its namespace with a bare, proof-less
// mkdir, so the reservation's own mtime is the only liveness signal. Use the
// publication fence's freshness window: a crashed remover's reservation is
// swept by a later pass once it goes stale.
const RESERVATION_FRESH_MS = 1_000;

function assertOwnership(optionsOrCallback) {
  const callback = typeof optionsOrCallback === 'function'
    ? optionsOrCallback
    : optionsOrCallback?.assertOwnership
      || optionsOrCallback?.assertGeneration
      || (typeof optionsOrCallback?.generation === 'function'
        ? optionsOrCallback.generation : null);
  if (!callback) return;
  if (callback() === false) throw new AtomicOwnershipLostError();
}

function isOwnershipLoss(error) {
  return Boolean(error?.leaseLost
    || error?.code === 'ERR_ATOMIC_OWNERSHIP_LOST'
    || error?.code === 'ERR_BIN_LIFECYCLE_LEASE_LOST');
}

function capturePublishedSnapshot(path, options) {
  runTestInterlock(options, 'write-before-destination-inspection');
  if (process.env.CAH_TEST_ONLY === '1') {
    const count = Number.parseInt(
      process.env.CAH_TEST_ONLY_FSUTIL_DESTINATION_READ_FAILURES, 10,
    );
    if (Number.isSafeInteger(count) && count > 0) {
      process.env.CAH_TEST_ONLY_FSUTIL_DESTINATION_READ_FAILURES = String(count - 1);
      throw new Error('test-only post-publication destination inspection failure');
    }
  }
  return captureRegularFileSnapshot(path);
}

/** Atomically publish a file with optional parent, destination, and ownership fences. */
export function writeFileAtomic(destPath, payload, options = {}) {
  const { parentIdentities = null } = options;
  const expectedDestination = options.expectedDestination === undefined
    ? undefined
    : normalizeExpectedDestination(options.expectedDestination);
  const mode = options.mode;
  const priorMode = mode === undefined
    ? expectedDestination?.exists
      ? modeFromExpected(expectedDestination)
      : existingRegularFileMode(destPath)
    : null;
  const tempMode = mode ?? priorMode ?? 0o666;
  const createParents = options.createParents ?? parentIdentities === null;
  assertOwnership(options);
  if (createParents) {
    assertOwnership(options);
    mkdirSync(dirname(destPath), { recursive: true });
  }
  assertDirectoryIdentities(parentIdentities);
  const data = toBuffer(payload);
  let tmp = null;
  let fd = null;
  let tempSnapshot = null;
  let tempEntryIdentity = null;
  let committedPublication = null;
  try {
    ({ path: tmp, fd } = openUniqueSiblingTemp(destPath, tempMode, options));
    tempEntryIdentity = lstatSync(tmp, { bigint: true });
    // These are test-only crash boundaries.  They deliberately sit after the
    // private inode exists and after its first write so recovery is exercised
    // against a real child-process interruption, including malformed bytes.
    runTestInterlock(options, 'write-after-temp-create', 'write-after-transaction-temp-create');
    assertDirectoryIdentities(parentIdentities);
    writeAll(fd, data, options);
    // Set mode on the private entry; never chmod the canonical destination.
    if (mode !== undefined || priorMode !== null) {
      assertOwnership(options);
      chmodSync(tmp, tempMode);
    }
    // The rename is only crash-durable when the complete private payload has
    // reached storage first.  Directory sync is best-effort only for the
    // explicitly unsupported Windows directory-handle case.
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    syncDirectory(dirname(tmp));
    // Keep the private inode identity so a byte-identical successor is rejected.
    tempSnapshot = captureRegularFileSnapshot(tmp);
    if (!tempSnapshot.present) throw new Error('atomic temp file changed concurrently; refusing operation');
    assertDirectoryIdentities(parentIdentities);
    // Re-check the caller's destination snapshot immediately before publication.
    runTestInterlock(options, 'rename-retry');
    runTestInterlock(options, 'write-before-rename');
    if (options.testInterlockPhase) {
      runTestInterlock(options, options.testInterlockPhase);
    } else {
      runTestInterlock(options, 'write-before-final-publication');
      runTestInterlock(options, 'write-before-final-operation');
    }
    assertDirectoryIdentities(parentIdentities);
    assertOwnership(options);
    committedPublication = publishWithFence(
      destPath, tmp, tempSnapshot.expectedDestination.identity, expectedDestination, options,
    );
    tmp = null;
    runTestInterlock(options, 'write-after-rename', 'write-post-rename');
    assertOwnership(options);
    const publishedSnapshot = capturePublishedSnapshot(destPath, options);
    if (!publishedSnapshot.present
        || !sameFileIdentity(
          publishedSnapshot.expectedDestination.identity,
          tempSnapshot.expectedDestination.identity,
        )
        || publishedSnapshot.contentDigest !== tempSnapshot.contentDigest) {
      throw new Error('managed destination leaf changed concurrently; refusing operation');
    }
    assertDirectoryIdentities(parentIdentities);
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
    const committed = e.committedPublication || committedPublication;
    if (committed) {
      const identity = committed.tempIdentity ?? committed.identity;
      const digest = committed.contentDigest ?? committed.tempDigest ?? contentDigest(data);
      const bytes = committed.contentBytes ?? committed.tempBytes ?? data.byteLength;
      e.committedPublication = {
        path: destPath,
        present: true,
        content: data,
        contentDigest: digest,
        contentBytes: bytes,
        identity,
        expectedDestination: {
          exists: true,
          identity,
          mode: identity?.mode ?? null,
          contentDigest: digest,
          contentBytes: bytes,
        },
      };
    }
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // preserve the original write/open/rename failure
      }
    }
    // Don't strand a half-written temp file (it would later be mistaken for a
    // user file inside a skill dir). Best-effort cleanup, then rethrow.
    if (tmp !== null) {
      try {
        const current = lstatMaybe(tmp);
        const samePrivateEntry = current && tempEntryIdentity
          && current.dev === tempEntryIdentity.dev && current.ino === tempEntryIdentity.ino;
        if (samePrivateEntry || sameFileIdentity(
          regularFileIdentity(tmp), tempSnapshot?.expectedDestination?.identity,
        )) {
          unlinkSync(tmp);
        }
      } catch {
        // preserve the original error
      }
    }
    throw e;
  }
}

function normalizeExpectedDestination(expected) {
  if (expected === null || expected === undefined) {
    return { exists: false, identity: null, mode: null, contentDigest: null, contentBytes: 0 };
  }
  if (expected.exists !== undefined || expected.present !== undefined) {
    return {
      exists: Boolean(expected.exists ?? expected.present),
      identity: expected.identity ?? null,
      mode: expected.mode ?? expected.identity?.mode ?? null,
      contentDigest: expected.contentDigest ?? null,
      contentBytes: expected.contentBytes ?? null,
    };
  }
  return {
    exists: true,
    identity: expected,
    mode: expected?.mode ?? null,
    contentDigest: null,
    contentBytes: null,
  };
}

function modeFromExpected(expected) {
  if (typeof expected?.mode !== 'bigint') return null;
  return Number(expected.mode & 0o7777n);
}

function toBuffer(payload) {
  if (typeof payload === 'string') return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return payload;
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError('writeFileAtomic: payload must be a string, Buffer, or ArrayBuffer view');
}

function openUniqueSiblingTemp(destPath, mode = 0o666, options = {}) {
  const dir = dirname(destPath);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  let lastCollision = null;
  for (let attempt = 0; attempt < TEMP_CREATE_RETRIES; attempt++) {
    assertOwnership(options);
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
function writeAll(fd, data, options = {}) {
  let offset = 0;
  while (offset < data.byteLength) {
    assertOwnership(options);
    const remaining = data.byteLength - offset;
    const partialTest = process.env.CAH_TEST_ONLY === '1'
      && process.env.CAH_TEST_ONLY_ATOMIC_PARTIAL_WRITE === '1';
    const writeLength = partialTest && offset === 0 && remaining > 1
      ? Math.max(1, Math.floor(remaining / 2)) : remaining;
    const written = writeSync(fd, data, offset, writeLength);
    if (written === 0) throw new Error('writeFileAtomic: zero-byte write');
    offset += written;
    if (offset > 0) {
      runTestInterlock(options, 'write-after-temp-partial',
        'write-after-temp-partial-write', 'write-after-transaction-temp-partial');
    }
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — keeps this sync and zero-dep */ }
}
function assertDirectoryIdentities(snapshot) {
  if (snapshot !== null && !directoryIdentitiesMatch(snapshot)) {
    throw new Error('managed destination parent changed concurrently; refusing operation');
  }
}
export function removeOwnedRegularFile(path, expected, options = {}) {
  const { parentIdentities = null } = options;
  assertOwnership(options);
  assertDirectoryIdentities(parentIdentities);
  // Reserve the deterministic quarantine namespace before touching the leaf.
  const quarantineDir = deterministicQuarantinePath(path);
  const quarantineIdentity = reserveQuarantineNamespace(quarantineDir, options);
  if (!quarantineIdentity) return preservedRemoval(existingQuarantinePath(quarantineDir), 'occupied');

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
    const moved = renameForRemoval(
      path, quarantine, effectiveExpected.identity, parentIdentities, options,
    );
    if (moved === 'preserved') return preservedRemoval(existingQuarantinePath(quarantineDir), 'occupied');
    if (!moved) {
      if (!releaseReservation()) return preservedRemoval(existingQuarantinePath(quarantineDir), 'reservation-changed');
      return false;
    }
  } catch (e) {
    if (isOwnershipLoss(e)) {
      // Only the private reservation may be cleaned after ownership loss.
      releaseReservation();
      throw e;
    }
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
  runTestInterlock(options, 'remove-after-rename');
  const movedSnapshot = captureRegularFileSnapshot(quarantine);
  if (!movedSnapshot.present
      || !sameFileIdentity(movedSnapshot.expectedDestination.identity, effectiveExpected.identity)
      || movedSnapshot.contentDigest !== effectiveExpected.contentDigest
      || movedSnapshot.contentBytes !== effectiveExpected.contentBytes) {
    // If the canonical name is occupied by a successor, restoration cannot
    // safely replace it. Leave the displaced entry in its deterministic,
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
  let payloadRemoved = false;
  let reservationReleased = true;
  try {
    runTestInterlock(options, 'remove-before-unlink');
    if (!unlinkExpectedQuarantine(
      quarantine, effectiveExpected.identity, quarantineDir, quarantineIdentity, parentIdentities,
       effectiveExpected.contentDigest, options,
    )) {
      return preservedRemoval(quarantine, 'quarantine-changed');
    }
    payloadRemoved = true;
  } catch (e) {
    // The identity check above is deliberately repeated by the cleanup
    // helper. If cleanup loses its race, the moved entry remains recoverable.
    throw e;
  } finally {
    // Once the validated payload is gone, releasing our empty namespace is
    // safe even if the caller's lease expires. rmdirSync is identity- and
    // emptiness-checked, so a successor in the reservation is preserved.
    if (payloadRemoved) reservationReleased = releaseReservation();
  }
  if (!reservationReleased) {
    return preservedRemoval(existingQuarantinePath(quarantineDir), 'reservation-changed');
  }
  return true;
}
function unlinkExpectedQuarantine(
  path, expected, quarantineDir, quarantineIdentity, parentIdentities, expectedDigest = null,
  options = {},
) {
  assertOwnership(options);
  assertDirectoryIdentities(parentIdentities);
  if (!sameDirectoryIdentity(directoryIdentity(quarantineDir), quarantineIdentity)) return false;
  if (!sameFileIdentity(regularFileIdentity(path), expected)) return false;
  const snapshot = captureRegularFileSnapshot(path);
  if (!snapshot.present || (expectedDigest !== null && snapshot.contentDigest !== expectedDigest)) {
    return false;
  }
  return unlinkForRemoval(
    path, expected, parentIdentities, quarantineDir, quarantineIdentity, expectedDigest, options,
  );
}
function isTransientFsError(error) {
  return RETRY_CODES.has(error.code);
}
function renameForRemoval(from, to, expected, parentIdentities, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    // A transient rename failure leaves a window in which another writer can
    // replace the source. Revalidate the exact inode before every attempt;
    // otherwise a retry can move a successor into our quarantine.
    assertOwnership(options);
    assertDirectoryIdentities(parentIdentities);
    if (!sameFileIdentity(regularFileIdentity(from), expected)) return false;
    if (lstatMaybe(to) !== null) return 'preserved';
    runTestInterlock(options, 'remove-before-rename');
    assertOwnership(options);
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
      runTestInterlock(options, 'remove-retry');
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
      assertOwnership(options);
    }
  }
  throw lastErr;
}
function unlinkForRemoval(path, expected = null, parentIdentities = null,
  quarantineDir = null, quarantineIdentity = null, expectedDigest = null, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertOwnership(options);
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
      assertOwnership(options);
      if (shouldInjectUnlinkEnoent()) {
        const injected = new Error(`ENOENT: no such file or directory, unlink '${path}'`);
        injected.code = 'ENOENT';
        throw injected;
      }
      unlinkSync(path);
      runTestInterlock(options, 'remove-after-unlink');
      return true;
    } catch (e) {
      lastErr = e;
      // A concurrent remover won the race: the entry is already gone, which
      // is this primitive's goal, not a failure (removeClaimPath(),
      // removeEmptyDirectory() and releaseQuarantineReservation() agree).
      if (e.code === 'ENOENT') return true;
      if (!isTransientFsError(e)) throw e;
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
      assertOwnership(options);
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
function shouldInjectUnlinkEnoent() {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  return process.env.CAH_TEST_ONLY_FSUTIL_UNLINK_ENOENT === '1';
}
function deterministicQuarantinePath(path) {
  return `${path}.cah-owned-remove`;
}
function reserveQuarantineNamespace(path, options = {}) {
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertOwnership(options);
    try {
      mkdirSync(path);
      const identity = directoryIdentity(path);
      if (identity) return identity;
      return null;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const identity = directoryIdentity(path);
      if (!identity || !directoryIsEmpty(path)
          || !sameDirectoryIdentity(directoryIdentity(path), identity)) return null;
      try {
        rmdirSync(path);
        continue;
      } catch (removeError) {
        if (removeError.code === 'ENOENT') continue;
        if (removeError.code === 'ENOTEMPTY' || removeError.code === 'EEXIST') return null;
        if (!isTransientFsError(removeError) || attempt === RENAME_RETRIES - 1) return null;
        sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
      }
    }
  }
  return null;
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
  assertOwnership(options);
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
export function enumerateRecoveryArtifacts(root, options = {}) {
  const baseLimit = options.limit;
  const displacedLimit = boundedLimit(options.displacedLimit ?? options.payloadLimit ?? baseLimit, RECOVERY_LIMIT);
  const namespaceLimit = boundedLimit(options.namespaceLimit ?? options.nonDisplacedLimit ?? options.payloadLimit ?? baseLimit, RECOVERY_LIMIT);
  const tempLimit = boundedLimit(options.tempLimit ?? options.limit, RECOVERY_LIMIT);
  const state = { visits: 0, truncated: false, incomplete: false, failures: [] };
  const directory = recoveryDirectory(root, state);
  if (!directory) return recoveryArtifactList(state, [], { displaced: [], namespaces: [], temps: [] });
  const wanted = options.canonicalPath ? resolve(options.canonicalPath) : null;
  const displaced = [], namespaces = [], temps = [];
  scanRecoveryCategory(directory, 'displaced', state, (artifact) => {
    if (artifact.displacedData && displaced.length < displacedLimit) {
      addRecoveryArtifact(displaced, artifact, wanted);
    }
  }, boundedLimit(options.displacedVisitLimit ?? options.visitLimit, RECOVERY_DISPLACED_VISIT_LIMIT));
  scanRecoveryCategory(directory, 'namespace', state, (artifact) => {
    if (!artifact.displacedData && artifact.kind !== 'temp' && namespaces.length < namespaceLimit) {
      addRecoveryArtifact(namespaces, artifact, wanted);
    }
  }, boundedLimit(options.namespaceVisitLimit ?? options.visitLimit, RECOVERY_VISIT_LIMIT));
  scanRecoveryCategory(directory, 'temp', state, (artifact) => {
    if (artifact.kind === 'temp' && temps.length < tempLimit) {
      addRecoveryArtifact(temps, artifact, wanted);
    }
  }, boundedLimit(options.tempVisitLimit ?? options.visitLimit, RECOVERY_VISIT_LIMIT));
  return recoveryArtifactList(state, [...displaced, ...namespaces, ...temps], { displaced, namespaces, temps });
}
function recoveryArtifactList(metadata, values = [], categories = {}) {
  for (const [key, value] of Object.entries({ ...metadata, ...categories })) {
    Object.defineProperty(values, key, { value, enumerable: false, configurable: true });
  }
  return values;
}
function scanRecoveryCategory(directory, category, state, visit, requestedVisitLimit) {
  const isDisplaced = category === 'displaced';
  const maxVisits = isDisplaced && process.env.CAH_TEST_ONLY === '1' ? parseTestVisitLimit('displaced', RECOVERY_DISPLACED_VISIT_LIMIT) : isDisplaced ? RECOVERY_DISPLACED_VISIT_LIMIT : RECOVERY_VISIT_LIMIT;
  const categoryLimit = boundedLimit(requestedVisitLimit, maxVisits);
  let handle = null;
  try {
    if (recoveryFailureInjected('opendir')) throw injectedRecoveryError('opendir');
    handle = opendirSync(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') recordRecoveryFailure(state, directory, error);
    return;
  }
  let visits = 0;
  try {
    while (visits < categoryLimit) {
      const entry = readRecoveryEntry(handle, directory, state);
      if (entry === undefined || entry === null) break;
      visits++;
      state.visits++;
      try {
        const artifact = describeRecoveryArtifact(directory, entry, state);
        if (artifact) visit(artifact);
      } catch (error) {
        recordRecoveryFailure(state, join(directory, entry.name), error);
      }
    }
    // One bounded lookahead distinguishes exact-cap EOF from truncation and is not a visit.
    if (categoryLimit > 0 && visits >= categoryLimit) {
      const lookahead = readRecoveryEntry(handle, directory, state);
      if (lookahead !== undefined && lookahead !== null) state.truncated = true;
    }
  } finally {
    try { handle.closeSync(); } catch (error) { recordRecoveryFailure(state, directory, error); }
  }
}
function readRecoveryEntry(handle, directory, state) {
  try { if (recoveryFailureInjected('read')) throw injectedRecoveryError('read'); return handle.readSync(); }
  catch (error) { recordRecoveryFailure(state, directory, error); return undefined; }
}
function addRecoveryArtifact(values, artifact, wanted) {
  if (wanted && resolve(artifact.canonicalPath ?? '') !== wanted) return;
  if (!values.some((existing) => existing.path === artifact.path)) values.push(artifact);
}
function parseTestVisitLimit(category, fallback) {
  const raw = process.env[`CAH_TEST_ONLY_FSUTIL_RECOVERY_${category.toUpperCase()}_VISITS`];
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function recoveryFailureInjected(kind) {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const values = [process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_FAILURE,
    process.env.CAH_TEST_ONLY_FSUTIL_RECOVERY_EACCES === '1' ? 'all' : ''].flatMap((value) => String(value || '').split(','));
  return values.includes('1') || values.includes('all') || values.includes(kind);
}
function injectedRecoveryError(kind) {
  const error = new Error(`test-only recovery ${kind} failure`);
  error.code = 'EACCES';
  return error;
}
function recordRecoveryFailure(state, path, error) {
  if (error?.code === 'ENOENT') return;
  state.incomplete = true;
  if (state.failures.length < 8) state.failures.push({ path, code: error?.code || 'UNKNOWN' });
}
// An empty, proof-less publication fence is what cleanupPublicationFence()
// leaves when a crash or failed rmdir lands between its unlink loop and its
// rmdir, and what beginFence()'s unwind leaves when that rmdir fails. No
// proof exists to defer to, and nothing else ever reclaims it for an
// abandoned leaf, so the sweep applies what an acquirer already treats as
// reclaimable: an empty fence past the fence freshness window (the same
// FENCE_STALE_MS fenceIsStale() uses for proof-less fences). A live
// publisher's unproved span is microseconds, comfortably inside it.
function unprovedFenceStaleMs() {
  if (process.env.CAH_TEST_ONLY !== '1') return FENCE_STALE_MS;
  const override = Number.parseInt(process.env.CAH_TEST_ONLY_FENCE_STALE_MS, 10);
  return Number.isSafeInteger(override) && override > 0 ? override : FENCE_STALE_MS;
}
function reclaimableUnprovedPublicationFence(artifact) {
  const current = lstatMaybe(artifact.path);
  return Boolean(current?.isDirectory() && sameStatIdentity(current, artifact.identity)
    && directoryIsEmpty(artifact.path)
    && isOlderThan(current, Date.now(), unprovedFenceStaleMs()));
}
export function sweepRecoveryArtifacts(root, options = {}) {
  const artifacts = enumerateRecoveryArtifacts(root, options);
  const limit = boundedLimit(options.limit, RECOVERY_SWEEP_LIMIT);
  const swept = [];
  const preserved = [];
  let attempted = 0;
  for (const artifact of artifacts) {
    if (attempted >= limit) {
      preserved.push(artifact.path);
      continue;
    }
    if (artifact.kind === 'temp' && provenOwnedTemp(artifact, options.ownedTempPaths)) {
      attempted++;
      const current = lstatMaybe(artifact.path);
      if (current?.isFile() && sameStatIdentity(current, artifact.identity)) {
        assertOwnership(options);
        try {
          unlinkSync(artifact.path);
          swept.push(artifact.path);
          continue;
        } catch {
          // A failed or racing cleanup is reportable, never destructive.
        }
      }
    } else if (artifact.kind === 'publication' && !artifact.displacedData
      && (artifact.publicationProof || provenOwnedPath(artifact.path, options.ownedPublicationPaths)
        || reclaimableUnprovedPublicationFence(artifact))) {
      attempted++;
      const current = lstatMaybe(artifact.path);
      if (current?.isDirectory() && sameStatIdentity(current, artifact.identity)) {
        assertOwnership(options);
        try {
          const recovered = artifact.publicationProof
            // Maintenance is not a fence acquirer: defer to any live, in-flight
            // publisher in both exposure windows — before the canonical rename
            // (deferFresh) and between the rename and the publisher's own fence
            // cleanup (deferCommitted). A genuinely crashed publisher (dead
            // pid, stale proof) is still recovered.
            ? recoverPublicationFence(artifact.canonicalPath,
              { ...options, deferFresh: true, deferCommitted: true })
            // Unproved but owned (ownedPublicationPaths) or stale-and-empty
            // (reclaimableUnprovedPublicationFence): recheck emptiness
            // immediately before rmdir, exactly like the quarantine branch.
            : directoryIsEmpty(artifact.path) && (rmdirSync(artifact.path), true);
          if (recovered) {
            swept.push(artifact.path);
            continue;
          }
        } catch {
          // Preserve a concurrently populated, inaccessible, or unproved namespace.
        }
      }
    } else if (artifact.kind === 'quarantine' && !artifact.displacedData) {
      attempted++;
      const current = lstatMaybe(artifact.path);
      // Recheck identity, emptiness, and liveness immediately before rmdir.
      // A successor or foreign entry causes preservation, and so does a
      // fresh reservation: removeOwnedRegularFile() holds an empty,
      // proof-less reservation twice during a live removal, and its mtime is
      // the only signal distinguishing that from crashed state.
      if (current?.isDirectory() && directoryIsEmpty(artifact.path)
          && sameStatIdentity(current, artifact.identity)
          && isOlderThan(current, Date.now(), RESERVATION_FRESH_MS)) {
        assertOwnership(options);
        try {
          rmdirSync(artifact.path);
          swept.push(artifact.path);
          continue;
        } catch {
          // A failed or racing cleanup is reportable, never destructive.
        }
      }
    }
    preserved.push(artifact.path);
  }
  return { swept, preserved, artifacts, visits: artifacts.visits || 0,
    truncated: Boolean(artifacts.truncated), incomplete: Boolean(artifacts.incomplete),
    failures: artifacts.failures || [] };
}
export function maintainRecoveryArtifacts(root, options = {}) {
  let result;
  try {
    result = sweepRecoveryArtifacts(root, options);
  } catch (error) {
    if (isOwnershipLoss(error)) throw error;
    const failure = { path: resolve(root), code: error?.code || 'UNKNOWN' };
    return { swept: [], preserved: [], recovery: [], unprovedTemps: [], visits: 0,
      truncated: false, incomplete: true, failures: [failure] };
  }
  const swept = new Set(result.swept.map((path) => resolve(path)));
  const recovery = [];
  const unprovedTemps = [];
  const preserved = [];
  for (const artifact of result.artifacts) {
    if (artifact.inspectionIncomplete) result.incomplete = true;
    if (artifact.inspectionIncomplete) addUniquePath(recovery, artifact.path);
    if (artifact.displacedData) {
      addUniquePath(recovery, artifact.path);
      continue;
    }
    if (swept.has(resolve(artifact.path)) || lstatMaybe(artifact.path) === null) continue;
    if (artifact.kind === 'temp') addUniquePath(unprovedTemps, artifact.path);
    addUniquePath(preserved, artifact.path);
  }
  return { ...result, recovery, unprovedTemps, preserved, visits: result.visits || 0,
    truncated: Boolean(result.truncated), incomplete: Boolean(result.incomplete || result.truncated) };
}
function addUniquePath(values, path) {
  const normalized = resolve(path); if (!values.some((candidate) => resolve(candidate) === normalized)) values.push(path);
}
function recoveryDirectory(root, state = null) {
  const observed = recoveryLstat(root, 'root', state);
  return observed === undefined || observed === null ? null : observed.isDirectory() ? root : dirname(root);
}
function describeRecoveryArtifact(directory, entry, state = null) {
  const name = entry.name;
  const path = join(directory, name);
  if (name.startsWith('.cah-tmp-')) {
    const identity = recoveryLstat(path, 'temp', state);
    return {
      kind: 'temp', path, canonicalPath: null, canonicalPresent: null,
      displacedData: false, safeToSweep: false, identity,
      owned: false,
    };
  }
  if (name === LEASE_QUARANTINE_DIR) {
    const identity = recoveryLstat(path, 'namespace', state);
    const empty = identity !== null && identity !== undefined && identity.isDirectory()
      ? directoryEmptyMaybe(path, state) : true;
    return {
      kind: 'lease-quarantine', path, rootPath: path,
      canonicalPath: null, canonicalPresent: null,
      displacedData: identity !== null && identity !== undefined && empty === false,
      inspectionIncomplete: identity === undefined || empty === undefined,
      safeToSweep: false, publicationProof: false,
      identity, owned: false,
    };
  }
  if (name === CAPACITY_QUARANTINE_DIR || name.includes(LEASE_ABANDONED_MARKER)) {
    const identity = recoveryLstat(path, 'namespace', state);
    const empty = identity !== null && identity !== undefined && identity.isDirectory()
      ? directoryEmptyMaybe(path, state) : true;
    return {
      kind: name === CAPACITY_QUARANTINE_DIR ? 'capacity-quarantine' : 'lease-abandoned',
      path, rootPath: path,
      canonicalPath: null, canonicalPresent: null,
      displacedData: identity !== null && identity !== undefined && empty === false,
      inspectionIncomplete: identity === undefined || empty === undefined,
      safeToSweep: false, publicationProof: false,
      identity, owned: false,
    };
  }
  const kind = name.endsWith(QUARANTINE_MARKER)
    ? 'quarantine'
    : name.endsWith(PUBLICATION_FENCE_SUFFIX) ? 'publication' : null;
  if (!kind) return null;
  const suffix = kind === 'quarantine' ? QUARANTINE_MARKER : PUBLICATION_FENCE_SUFFIX;
  const canonicalPath = path.slice(0, -suffix.length);
  const canonical = recoveryLstat(canonicalPath, 'canonical', state);
  const canonicalPresent = canonical === undefined ? null : canonical !== null;
  const identity = recoveryLstat(path, 'namespace', state);
  const childName = kind === 'quarantine' ? QUARANTINE_CHILD : PUBLICATION_FENCE_CHILD;
  const childPath = identity?.isDirectory() ? join(path, childName) : path;
  const child = identity?.isDirectory() ? recoveryLstat(childPath, 'child', state) : identity;
  const publicationProof = kind === 'publication'
    ? readPublicationProof(path) || recoveryLstat(join(path, `${PUBLICATION_PROOF_FILE}.tmp`), 'proof', state)
    : null;
  const displacedData = child !== null && child !== undefined;
  const inspectionIncomplete = canonical === undefined || identity === undefined || child === undefined;
  return {
    kind,
    path: displacedData ? childPath : path,
    rootPath: path,
    canonicalPath,
    canonicalPresent,
    displacedData,
    inspectionIncomplete,
    safeToSweep: !displacedData && (kind === 'quarantine' || kind === 'publication'),
    publicationProof: Boolean(publicationProof),
    identity: displacedData ? child : identity,
    owned: false,
  };
}

function recoveryLstat(path, kind, state = null) {
  try {
    if (recoveryFailureInjected(kind)) throw injectedRecoveryError(kind);
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (state) recordRecoveryFailure(state, path, error);
    return undefined;
  }
}

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, fallback) : fallback;
}

function sameStatIdentity(left, right) {
  return !!left && !!right
    && sameStatInteger(left.dev, right.dev)
    && sameStatInteger(left.ino, right.ino)
    && sameStatInteger(left.mode, right.mode)
    && sameStatInteger(left.size, right.size)
    && sameStatInteger(left.mtimeNs, right.mtimeNs);
}

function directoryIsEmpty(path) {
  try {
    const handle = opendirSync(path);
    try { return handle.readSync() === null; } finally { handle.closeSync(); }
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EPERM') return false;
    throw e;
  }
}

// directoryIsEmpty that reports rather than throws: `undefined` means the
// emptiness could not be inspected and the caller must flag the artifact.
function directoryEmptyMaybe(path, state) {
  try {
    if (recoveryFailureInjected('empty')) throw injectedRecoveryError('empty');
    const handle = opendirSync(path);
    try { return handle.readSync() === null; } finally { handle.closeSync(); }
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    if (state) recordRecoveryFailure(state, path, e);
    return undefined;
  }
}

function provenOwnedTemp(artifact, ownedTempPaths) {
  if (!ownedTempPaths) return false;
  const path = resolve(artifact.path);
  if (ownedTempPaths instanceof Map) {
    const proof = ownedTempPaths.get(path) ?? ownedTempPaths.get(artifact.path);
    return proof === true || (proof && sameStatIdentity(artifact.identity, proof));
  }
  return Array.from(ownedTempPaths).some((candidate) => resolve(candidate) === path);
}

function provenOwnedPath(path, ownedPaths) {
  if (!ownedPaths) return false;
  const absolute = resolve(path);
  if (ownedPaths instanceof Map) return ownedPaths.has(absolute) || ownedPaths.has(path);
  return Array.from(ownedPaths).some((candidate) => resolve(candidate) === absolute);
}

function runTestInterlock(options, ...phases) {
  options?.testInterlock?.(...phases);
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
