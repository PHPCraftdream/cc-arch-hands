import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync, renameSync,
  rmdirSync, unlinkSync, writeSync, readFileSync, linkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  captureRegularFileSnapshot, directoryIdentity, regularFileIdentity,
  sameDirectoryIdentity, sameFileIdentity, lstatMaybe,
} from './fs-atomic-identity.js';
import { leaseExpired, sleepSyncWait as sleepSync } from './lease-clock.js';

// Transient fence-mkdir rejections (EPERM/EACCES/EBUSY under real Windows
// concurrency from AV/indexer/journaling lag): the established transient set
// minus EEXIST (its own recovery path). Bounded so denied access fails fast —
// but the bound must be comparable to the EEXIST path's own budget (~100
// attempts, exponential backoff, tens of seconds worst case), not a fraction
// of it: CI observed a real Windows EPERM (fence directory in delete-pending
// state under six real processes racing the same leaf, 720 total attempts)
// outlive a 2s window and surface raw, unrecovered.
const FENCE_MKDIR_TRANSIENT_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const FENCE_TRANSIENT_WINDOW_MS = 15_000;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const RENAME_RETRIES = 5;
const RENAME_BASE_MS = 20;
const FENCE_ACQUIRE_RETRIES = 100;
export const FENCE_STALE_MS = 1_000;
// Commit-time deferral window: exceeds any realistic maintenance pass over a
// live publisher; reclaim stays safe because finishPublication() tolerates a
// benign third-party completion (see below).
const COMMITTED_DEFER_MS = 15_000;
export const PUBLICATION_FENCE_SUFFIX = '.cah-owned-publish';
export const PUBLICATION_PROOF_FILE = 'publication.json';
const PUBLICATION_PROOF_TEMP = `${PUBLICATION_PROOF_FILE}.tmp`;
const FENCE_CHILD = 'old';
const PUBLICATION_PROOF_VERSION = 2;
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  'EBADF', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM',
  'ERR_INVALID_ARG_VALUE',
]);

export class AtomicOwnershipLostError extends Error {
  constructor() {
    super('ownership lost during atomic filesystem operation');
    this.name = 'AtomicOwnershipLostError';
    this.code = 'ERR_ATOMIC_OWNERSHIP_LOST';
    this.leaseLost = true;
  }
}

function assertOwnership(options) {
  const callback = options?.assertOwnership || options?.assertGeneration
    || (typeof options?.generation === 'function' ? options.generation : null);
  if (callback && callback() === false) throw new AtomicOwnershipLostError();
}

function runTestInterlock(options, ...phases) { options?.testInterlock?.(...phases); }

function attachCommittedPublication(error, publication, destination) {
  if (!publication?.published) return;
  error.committedPublication = {
    path: destination,
    identity: publication.tempIdentity,
    contentDigest: publication.tempDigest,
    contentBytes: publication.tempBytes,
  };
}

function transientRenameFailure(attempt) {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const count = Number.parseInt(process.env.CAH_TEST_ONLY_FSUTIL_RENAME_TRANSIENT_FAILURES, 10);
  return Number.isSafeInteger(count) && count > attempt;
}

function fenceMkdirTransientFailure(attempt) {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const count = Number.parseInt(
    process.env.CAH_TEST_ONLY_PUBLICATION_FENCE_MKDIR_TRANSIENT_FAILURES, 10,
  );
  return Number.isSafeInteger(count) && count > attempt;
}

function transient(error) { return RETRY_CODES.has(error.code); }

function conflict() {
  return new Error('managed destination leaf changed concurrently; refusing operation');
}

function encodeIdentity(identity) {
  if (!identity) return null;
  return {
    dev: String(identity.dev), ino: String(identity.ino), mode: String(identity.mode),
    size: String(identity.size), mtimeNs: String(identity.mtimeNs),
  };
}

function decodeIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    const identity = {
      dev: BigInt(value.dev), ino: BigInt(value.ino), mode: BigInt(value.mode),
      size: BigInt(value.size), mtimeNs: BigInt(value.mtimeNs),
    };
    identity.isFile = () => true;
    return identity;
  } catch { return null; }
}

function encodeDirectoryIdentity(identity) {
  if (!identity) return null;
  return { dev: String(identity.dev), ino: String(identity.ino) };
}

function decodeDirectoryIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  try { return { dev: BigInt(value.dev), ino: BigInt(value.ino) }; } catch { return null; }
}

function encodeExpected(expected) {
  return {
    exists: Boolean(expected?.exists),
    identity: encodeIdentity(expected?.identity),
    contentDigest: expected?.contentDigest ?? null,
    contentBytes: expected?.contentBytes ?? null,
  };
}

function decodeExpected(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    exists: Boolean(value.exists),
    identity: decodeIdentity(value.identity),
    contentDigest: value.contentDigest ?? null,
    contentBytes: value.contentBytes ?? null,
  };
}

function expectedDestinationMatches(path, expected) {
  const current = regularFileIdentity(path);
  if (!expected.exists) return current === null && lstatMaybe(path) === null;
  if (!sameFileIdentity(current, expected.identity)) return false;
  const snapshot = captureRegularFileSnapshot(path);
  return snapshot.present
    && (expected.contentDigest === null || snapshot.contentDigest === expected.contentDigest)
    && (expected.contentBytes === null || snapshot.contentBytes === expected.contentBytes);
}

function samePath(left, right) { return resolve(left) === resolve(right); }
function proofPath(fencePath) { return join(fencePath, PUBLICATION_PROOF_FILE); }
function proofTempPath(fencePath) { return join(fencePath, PUBLICATION_PROOF_TEMP); }

// Directory handles are syncable on Unix, but Windows does not provide a
// portable directory fsync primitive.  Treat only that documented capability
// gap as a successful best-effort operation; all other failures remain
// visible to the caller so a durability claim cannot be silently weakened.
export function syncDirectory(path) {
  let fd = null;
  try {
    const directoryFlag = typeof constants.O_DIRECTORY === 'number'
      ? constants.O_DIRECTORY : 0;
    fd = openSync(path, constants.O_RDONLY | directoryFlag);
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) {
      return false;
    }
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function syncParentDirectory(path) { return syncDirectory(dirname(path)); }

function fenceIsStale(path, proof = null, staleMs = FENCE_STALE_MS) {
  const proofTime = Number(proof?.createdAtMs);
  if (Number.isSafeInteger(proofTime)) {
    // A proof dated after "now" (a backward clock step after NTP correction
    // or a VM snapshot restore) must never pin the fence fresh for the whole
    // skew: treat a future timestamp as stale.
    if (proofTime > Date.now()) return true;
    return Date.now() - proofTime >= staleMs;
  }
  const fenceStat = lstatMaybe(path);
  if (!fenceStat?.mtimeNs || typeof fenceStat.mtimeNs !== 'bigint') return true;
  const fenceTime = Number(fenceStat.mtimeNs / 1_000_000n);
  return Number.isSafeInteger(fenceTime) && Date.now() - fenceTime >= staleMs;
}

function proofOwnerIsAlive(proof) {
  if (proof?.ownerState === 'abandoned') return false;
  const pid = Number(proof?.ownerPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) {
    return error.code === 'EPERM';
  }
}

function lifecycleLeaseFor(options) {
  const lease = options?.lifecycleLease || options?.lease || null;
  if (!lease) return null;
  const path = lease.path || lease.leasePath;
  const token = lease.token || lease.leaseToken || lease.owner?.token;
  const generation = lease.generation || lease.leaseGeneration || lease.owner?.generation;
  if (typeof path !== 'string' || typeof token !== 'string' || !token
      || typeof generation !== 'string' || !generation) return null;
  return { path: resolve(path), token, generation };
}

function lifecycleLeasesFor(options) {
  const supplied = Array.isArray(options?.lifecycleLeases)
    ? options.lifecycleLeases
    : (options?.lifecycleLease || options?.lease)
      ? [options.lifecycleLease || options.lease] : [];
  if (supplied.length === 0) return [];
  const leases = supplied.map((lease) => lifecycleLeaseFor({ lifecycleLease: lease }));
  return leases.every(Boolean) ? leases : null;
}

function readLeaseOwnerForRecovery(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    return owner && typeof owner.token === 'string' && typeof owner.generation === 'string'
      && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch { return null; }
}

function proofLeaseIdentities(proof) {
  return Array.isArray(proof?.leaseIdentities) && proof.leaseIdentities.length
    ? proof.leaseIdentities
    : proof?.leasePath || proof?.leaseToken || proof?.leaseGeneration
      ? [{ path: proof.leasePath, token: proof.leaseToken, generation: proof.leaseGeneration }]
      : [];
}

function verifiedLifecycleSuccessor(proof, options) {
  const currentLeases = lifecycleLeasesFor(options);
  if (!currentLeases) return false;
  const proofLeases = proofLeaseIdentities(proof);
  if (proofLeases.length === 0 || proofLeases.length < currentLeases.length) return false;
  // Do not trust metadata supplied by a caller until every live owner file
  // proves that this exact token and generation owns its lease path.
  let changed = false;
  for (const currentLease of currentLeases) {
    const proofLease = proofLeases.find((candidate) => resolve(candidate.path) === currentLease.path);
    if (!proofLease) return false;
    const current = readLeaseOwnerForRecovery(currentLease.path);
    if (!current || current.token !== currentLease.token
        || current.generation !== currentLease.generation) return false;
    if (proofLease.token !== currentLease.token || proofLease.generation !== currentLease.generation) {
      changed = true;
    }
  }
  return changed;
}

// A committed publisher still holding the exact lease its proof recorded is
// verifiably the same live transaction — but only while that lease is still
// being renewed: the owner file must carry the proof's own token and
// generation AND a heartbeat no older than the lease period, the same rule
// renewLease() applies. After a crash the untouched owner file with matching
// token/generation would otherwise defer the fence forever: a recycled pid
// never reacquired that token, and the next legitimate holder overwrites the
// owner file with its own identity, breaking the match and making the fence
// reclaimable again.
function committedLeaseStillHeld(proof) {
  const leases = proofLeaseIdentities(proof);
  if (leases.length === 0) return false;
  const nowMs = Date.now();
  return leases.every((lease) => {
    if (typeof lease?.path !== 'string' || typeof lease?.token !== 'string'
        || typeof lease?.generation !== 'string' || !lease.token || !lease.generation) {
      return false;
    }
    const current = readLeaseOwnerForRecovery(lease.path);
    return current !== null && current.token === lease.token
      && current.generation === lease.generation
      && !leaseExpired(current, nowMs);
  });
}

function writeDurableProof(path, proof) {
  const temp = proofTempPath(path.slice(0, -PUBLICATION_PROOF_FILE.length));
  let fd = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    const data = Buffer.from(`${JSON.stringify(proof)}\n`);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    syncParentDirectory(path);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* retain original error */ } }
    try { unlinkSync(temp); } catch { /* an interrupted write is recovery state */ }
    throw error;
  }
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

// A fence owner cleaning up its proof files races readers here; a vanished
// proof is the same torn-fence case a missing entry already causes, not an
// error. On Windows a concurrent unlink of the proof file can surface as a
// transient EPERM on open (delete-pending), hence EPERM tolerated beside
// ENOENT. Directory reads in the same recovery path can surface EPERM the
// same way, but those guards admit only ENOENT and rely on their callers'
// conservative preserve-and-report behavior; do not read this as a claim
// about them.
function readProofBytes(path) {
  try { return readFileSync(path); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EPERM') return null;
    throw error;
  }
}

function validProofShape(proof) {
  if (!proof || proof.version !== PUBLICATION_PROOF_VERSION
      || typeof proof.transactionId !== 'string' || !proof.transactionId
      || typeof proof.destination !== 'string' || typeof proof.fencePath !== 'string'
      || typeof proof.tempPath !== 'string' || !proof.fenceIdentity || !proof.tempIdentity
      || !proof.expected || !decodeDirectoryIdentity(proof.fenceIdentity)
      || !decodeExpected(proof.expected) || !Number.isSafeInteger(Number(proof.ownerPid))
      || !['active', 'abandoned'].includes(proof.ownerState)) return false;
  const leaseFields = [proof.leasePath, proof.leaseToken, proof.leaseGeneration]
    .filter((value) => value !== undefined && value !== null);
  const primaryValid = leaseFields.length === 0 || (leaseFields.length === 3
    && typeof proof.leasePath === 'string' && typeof proof.leaseToken === 'string'
    && typeof proof.leaseGeneration === 'string' && proof.leaseToken.length > 0
    && proof.leaseGeneration.length > 0);
  const identitiesValid = proof.leaseIdentities === undefined
    || (Array.isArray(proof.leaseIdentities) && proof.leaseIdentities.length > 0
      && proof.leaseIdentities.every((lease) => typeof lease?.path === 'string'
        && typeof lease.token === 'string' && lease.token.length > 0
        && typeof lease.generation === 'string' && lease.generation.length > 0));
  return primaryValid && identitiesValid;
}

function proofStateTime(proof) {
  const values = [proof?.updatedAtMs, proof?.abandonedAtMs, proof?.createdAtMs]
    .map(Number).filter(Number.isSafeInteger);
  return values.length ? Math.max(...values) : 0;
}

function proofCore(proof) {
  return JSON.stringify({
    version: proof.version,
    transactionId: proof.transactionId,
    destination: proof.destination,
    fencePath: proof.fencePath,
    fenceIdentity: proof.fenceIdentity,
    tempPath: proof.tempPath,
    tempIdentity: proof.tempIdentity,
    tempDigest: proof.tempDigest ?? null,
    tempBytes: proof.tempBytes ?? null,
    expected: proof.expected,
    ownerPid: proof.ownerPid,
    generation: proof.generation ?? null,
    leasePath: proof.leasePath ?? null,
    leaseToken: proof.leaseToken ?? null,
    leaseGeneration: proof.leaseGeneration ?? null,
    leaseIdentities: proof.leaseIdentities ?? null,
  });
}

function publicationProofState(fencePath) {
  const candidates = [proofPath(fencePath), proofTempPath(fencePath)].map((path) => {
    const entry = lstatMaybe(path);
    const identity = entry ? regularFileIdentity(path) : null;
    const proof = identity ? readJson(path) : null;
    return { path, proof, identity, present: entry !== null,
      valid: Boolean(identity && validProofShape(proof)) };
  });
  const canonical = candidates[0];
  const staging = candidates[1];
  const validCandidates = [];
  const discardable = [];

  // publication.json.tmp is a private, fixed-name proof staging slot. Once a
  // complete canonical proof has fenced the directory, a crash can leave a
  // truncated staging file behind. The canonical proof is authoritative in
  // that case; retain the staging inode identity so recovery can remove only
  // the exact file observed under the verified fence.
  if (canonical.valid) {
    validCandidates.push(canonical);
    if (staging.present) {
      if (staging.valid) {
        if (proofCore(staging.proof) !== proofCore(canonical.proof)) return null;
        validCandidates.push(staging);
      } else if (staging.identity) {
        discardable.push(staging);
      } else {
        return null;
      }
    }
  } else if (!canonical.present && staging.valid) {
    // A crash before the first proof rename may leave only the durable staging
    // copy. It is still a self-contained proof of this fence and transaction.
    validCandidates.push(staging);
  } else {
    // An unproved or non-regular fixed entry has no ownership authority.
    return null;
  }

  validCandidates.sort((left, right) => {
    const byTime = proofStateTime(right.proof) - proofStateTime(left.proof);
    return byTime || (right.path === proofPath(fencePath) ? 1 : -1);
  });
  return { proof: validCandidates[0].proof, candidates: validCandidates, discardable };
}

// A proof is the only authority generic maintenance has to act on a non-empty
// publication namespace. If a proof replacement was interrupted, return the
// newest complete state; a malformed fixed staging slot is recoverable only
// when a complete sibling already proves the fence and transaction.
export function readPublicationProof(fencePath) {
  return publicationProofState(fencePath)?.proof || null;
}

function proofPublication(fencePath, proof) {
  const expected = decodeExpected(proof.expected);
  const tempIdentity = decodeIdentity(proof.tempIdentity);
  const fenceIdentity = decodeDirectoryIdentity(proof.fenceIdentity);
  const currentFenceIdentity = directoryIdentity(fencePath);
  if (!expected || !tempIdentity || !fenceIdentity || !currentFenceIdentity
      || !sameDirectoryIdentity(fenceIdentity, currentFenceIdentity)
      || !samePath(proof.fencePath, fencePath)) return null;
  const state = publicationProofState(fencePath);
  if (!state || state.proof.transactionId !== proof.transactionId) return null;
  const ownedProofPath = state.candidates.find((candidate) => candidate.proof === proof)?.path
    || state.candidates.find((candidate) => candidate.proof.transactionId === proof.transactionId)?.path;
  const proofIdentity = ownedProofPath ? regularFileIdentity(ownedProofPath) : null;
  if (!ownedProofPath || !proofIdentity) return null;
  const proofContent = readProofBytes(ownedProofPath);
  const proofEntryContents = state.candidates.map((candidate) => readProofBytes(candidate.path));
  // The fence owner may be mid-unlink on its proof files; treat a vanished
  // proof like any other torn fence and let beginFence() retry.
  if (proofContent === null || proofEntryContents.includes(null)) return null;
  return {
    path: fencePath,
    identity: fenceIdentity,
    oldPath: join(fencePath, FENCE_CHILD),
    expected,
    tempPath: resolve(proof.tempPath),
    tempIdentity,
    tempDigest: proof.tempDigest ?? null,
    tempBytes: proof.tempBytes ?? null,
    proofPath: ownedProofPath,
    proofIdentity,
    proofContent,
    proofEntries: state.candidates.map((candidate, index) => ({
      path: candidate.path,
      identity: candidate.identity,
      content: proofEntryContents[index],
    })),
    discardableProofEntries: state.discardable.map((candidate) => ({
      path: candidate.path,
      identity: candidate.identity,
    })),
    published: false,
  };
}

function publicationProofFor(destPath, tempPath, tempIdentity, expected, fencePath, options) {
  const lifecycleLease = lifecycleLeaseFor(options.lifecycleLease || options.lease
    ? options : { lifecycleLease: options.lifecycleLeases?.[0] });
  const lifecycleLeases = lifecycleLeasesFor(options);
  if (options.lifecycleLease || options.lease
      || (Array.isArray(options.lifecycleLeases) && options.lifecycleLeases.length)) {
    if (!lifecycleLease || !lifecycleLeases) throw new Error('invalid lifecycle lease identity');
  }
  return {
    version: PUBLICATION_PROOF_VERSION,
    transactionId: randomUUID(),
    destination: resolve(destPath),
    fencePath: resolve(fencePath),
    fenceIdentity: encodeDirectoryIdentity(options.fenceIdentity),
    tempPath: resolve(tempPath),
    tempIdentity: encodeIdentity(tempIdentity),
    tempDigest: options.tempDigest ?? null,
    tempBytes: options.tempBytes ?? null,
    expected: encodeExpected(expected),
    createdAtMs: Date.now(),
    ownerPid: process.pid,
    ownerState: 'active',
    updatedAtMs: Date.now(),
    generation: typeof options.generation === 'string'
      ? options.generation : options.publicationGeneration ?? lifecycleLease?.generation ?? null,
    ...(lifecycleLease ? {
      leasePath: lifecycleLease.path,
      leaseToken: lifecycleLease.token,
      leaseGeneration: lifecycleLease.generation,
    } : {}),
    ...(lifecycleLeases?.length ? { leaseIdentities: lifecycleLeases } : {}),
  };
}

function validPublicationProof(fencePath, destPath, proof) {
  const publication = proofPublication(fencePath, proof);
  const destination = resolve(destPath);
  const temporary = publication ? resolve(publication.tempPath) : null;
  if (!publication || !publication.identity || !samePath(proof.destination, destPath)
      || !samePath(proof.fencePath, fencePath)
      || resolve(fencePath) !== `${destination}${PUBLICATION_FENCE_SUFFIX}`
      || dirname(temporary) !== dirname(destination)
      || temporary === destination
      || temporary === resolve(fencePath)
      || !basename(temporary).startsWith('.cah-tmp-')) return null;
  return publication;
}

function exactTemp(publication) {
  const current = regularFileIdentity(publication.tempPath);
  if (!sameFileIdentity(current, publication.tempIdentity)) return false;
  const snapshot = captureRegularFileSnapshot(publication.tempPath);
  return snapshot.present
    && (publication.tempDigest === null || snapshot.contentDigest === publication.tempDigest)
    && (publication.tempBytes === null || snapshot.contentBytes === publication.tempBytes);
}

function cleanupPublicationFence(publication, requireProof = true) {
  if (!publication?.identity
      || !sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) return false;
  let entries;
  try { entries = readdirSync(publication.path); } catch { return false; }
  const proofEntries = requireProof
    ? (publication.proofEntries?.length
      ? publication.proofEntries
      : publication.proofPath && publication.proofIdentity && publication.proofContent
        ? [{ path: publication.proofPath, identity: publication.proofIdentity,
          content: publication.proofContent }]
        : [])
    : [];
  if (requireProof && proofEntries.length === 0) return false;
  const allowed = new Set(requireProof
    ? proofEntries.map((entry) => entry.path)
    : [proofPath(publication.path), proofTempPath(publication.path)]);
  if (entries.some((entry) => !allowed.has(join(publication.path, entry)))) return false;
  if (requireProof && proofEntries.some((entry) =>
    !sameFileIdentity(regularFileIdentity(entry.path), entry.identity))) return false;
  const removed = [];
  try {
    for (const entry of entries) {
      const entryPath = join(publication.path, entry);
      unlinkSync(entryPath);
      removed.push(entryPath);
    }
    syncDirectory(publication.path);
    rmdirSync(publication.path);
    syncParentDirectory(publication.path);
    return true;
  } catch {
    // Restore only the exact proof entries we removed.  A successor or
    // foreign file at one of those names is never overwritten.
    if (requireProof && sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) {
      for (const removedPath of removed) {
        const proof = proofEntries.find((entry) => entry.path === removedPath);
        if (!proof || lstatMaybe(removedPath) !== null) continue;
        let fd = null;
        try {
          fd = openSync(removedPath, 'wx', 0o600);
          let offset = 0;
          while (offset < proof.content.length) {
            offset += writeSync(fd, proof.content, offset, proof.content.length - offset);
          }
          fsyncSync(fd);
          closeSync(fd);
          fd = null;
        } catch {
          if (fd !== null) { try { closeSync(fd); } catch { /* preserve recovery state */ } }
        }
      }
      try { syncDirectory(publication.path); } catch { /* recovery caller reports the incomplete fence */ }
    }
    return false;
  }
}

function cleanupDiscardableProofEntries(publication) {
  const entries = publication?.discardableProofEntries || [];
  if (entries.length === 0) return true;
  if (!sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) return false;
  for (const entry of entries) {
    // Only the fixed proof staging slot is eligible. Any other unexpected
    // entry remains foreign recovery state and must not be consumed here.
    if (entry.path !== proofTempPath(publication.path)
        || !sameFileIdentity(regularFileIdentity(entry.path), entry.identity)) return false;
    unlinkSync(entry.path);
  }
  syncDirectory(publication.path);
  return true;
}

function recoveryRequired(path) {
  const error = new Error(`atomic publication cleanup requires recovery: ${path}`);
  error.code = 'ERR_ATOMIC_RECOVERY_REQUIRED';
  error.recoveryPath = path;
  return error;
}

function destinationIsPublished(publication, destPath) {
  const snapshot = captureRegularFileSnapshot(destPath);
  return sameFileIdentity(snapshot.expectedDestination.identity, publication.tempIdentity)
    && (publication.tempDigest === null || snapshot.contentDigest === publication.tempDigest)
    && (publication.tempBytes === null || snapshot.contentBytes === publication.tempBytes);
}

function finishPublication(publication, destPath) {
  if (lstatMaybe(publication.tempPath) !== null
      || !destinationIsPublished(publication, destPath)) {
    throw recoveryRequired(publication.path);
  }
  if (cleanupPublicationFence(publication)) return;
  // The fence is no longer ours: a concurrent recovery pass verified this
  // exact publication committed and completed the cleanup for us. The check
  // above re-proved that the destination still carries our exact payload, the
  // commit point is behind us, and failing here would turn a completed
  // publication into a spurious ERR_ATOMIC_RECOVERY_REQUIRED — the exact
  // defect this file must not hand a merely-slow live publisher. A genuine
  // cleanup failure on a fence we still own stays loud below.
  const fenceIdentity = directoryIdentity(publication.path);
  if (fenceIdentity === null
      || !sameDirectoryIdentity(fenceIdentity, publication.identity)) return;
  throw recoveryRequired(publication.path);
}

function abortPublication(publication) {
  if (process.env.CAH_TEST_ONLY === '1'
      && process.env.CAH_TEST_ONLY_ABORT_PUBLICATION_FAILURE === '1') {
    throw new Error('test-only abort publication failure');
  }
  const temp = lstatMaybe(publication.tempPath);
  if (temp !== null && !exactTemp(publication)) return false;
  // Test-only late failure injection: fires after exactTemp()'s snapshot work
  // so tests exercise a partially-completed abort (inspection done, no
  // mutation yet) instead of one that never touched the filesystem.
  if (process.env.CAH_TEST_ONLY === '1'
      && process.env.CAH_TEST_ONLY_ABORT_PUBLICATION_FAILURE_LATE === '1') {
    throw new Error('test-only abort publication failure (late)');
  }
  // The canonical leaf may be a successor by the time an unpublished
  // transaction is unwound. That successor must never be replaced merely to
  // release our private proof fence.
  if (temp !== null) {
    unlinkSync(publication.tempPath);
    syncParentDirectory(publication.tempPath);
  }
  return cleanupPublicationFence(publication);
}

function recoverLegacyFence(destPath, fencePath, identity, options) {
  const oldPath = join(fencePath, FENCE_CHILD);
  const old = regularFileIdentity(oldPath);
  if (!old) {
    let entries;
    try { entries = readdirSync(fencePath); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EPERM') return false;
      throw error;
    }
    if (entries.length === 0 || (entries.length === 1 && entries[0] === PUBLICATION_PROOF_TEMP)) {
      if (!sameDirectoryIdentity(directoryIdentity(fencePath), identity)) return false;
      assertOwnership(options);
      try {
        if (entries.length === 1) unlinkSync(join(fencePath, PUBLICATION_PROOF_TEMP));
        syncDirectory(fencePath);
        rmdirSync(fencePath);
        syncParentDirectory(fencePath);
        return true;
      } catch { return false; }
    }
    return false;
  }
  const destination = regularFileIdentity(destPath);
  if (destination) {
    // A crash after the legacy hard-link but before old/cleanup leaves both
    // names attached to the same inode. Finish that exact transaction; never
    // remove the fenced inode when a different successor owns the destination.
    if (!sameFileIdentity(destination, old)) return false;
    assertOwnership(options);
    try {
      if (!sameFileIdentity(regularFileIdentity(oldPath), old)) return false;
      unlinkSync(oldPath);
      syncDirectory(fencePath);
      if (readdirSync(fencePath).length !== 0) return false;
      rmdirSync(fencePath);
      syncParentDirectory(fencePath);
      return true;
    } catch { return false; }
  }
  if (lstatMaybe(destPath) !== null) return false;
  assertOwnership(options);
  try {
    linkSync(oldPath, destPath);
    syncParentDirectory(destPath);
    if (!sameFileIdentity(regularFileIdentity(destPath), old)) return false;
    if (!sameFileIdentity(regularFileIdentity(oldPath), old)) return false;
    unlinkSync(oldPath);
    syncDirectory(fencePath);
    if (readdirSync(fencePath).length !== 0) return false;
    rmdirSync(fencePath);
    syncParentDirectory(fencePath);
    return true;
  } catch { return false; }
}

function recoverOccupiedFence(destPath, fencePath, options) {
  const identity = directoryIdentity(fencePath);
  if (!identity) return false;
  const proof = readPublicationProof(fencePath);
  const publication = proof && validPublicationProof(fencePath, destPath, proof);
  if (publication) {
    const committed = destinationIsPublished(publication, destPath);
    assertOwnership(options);
    if (committed) {
      // Two callers defer committed fences, for different owner sets:
      // Maintenance (deferCommitted) backs off while the publisher that
      // already renamed its payload is still live or fresh. beginFence()
      // (deferForeignCommitted) must finish a fence this same process created
      // unconditionally — proofOwnerIsAlive() is always true for our own pid —
      // but defers a foreign, live owner: reaping a live peer's committed
      // fence turns that publisher's own cleanup into a spurious recovery
      // error over data that already landed at the canonical destination.
      const foreignLiveOwner = Number(proof.ownerPid) !== process.pid
        && proofOwnerIsAlive(proof);
      // Pid liveness alone cannot distinguish a recycled pid from a genuinely
      // live, merely-slow publisher, so neither committed deferral rests on it
      // alone. Lease continuity defers only while the owner file still carries
      // the proof's exact token/generation AND a fresh heartbeat (the same
      // renewLease() expiry rule, so an abandoned lease stops deferring once
      // its heartbeat passes the lease period); a lease-less proof gets the
      // COMMITTED_DEFER_MS window. A dead publisher's fence stays reclaimable
      // either way; the old trailing disjunct is redundant here — each
      // deferral already implies it — so it is not repeated.
      const liveOwnerTrusted = committedLeaseStillHeld(proof)
        || !fenceIsStale(fencePath, proof, COMMITTED_DEFER_MS);
      const deferCommittedLive = options.deferCommitted
        && proofOwnerIsAlive(proof) && liveOwnerTrusted;
      const deferForeignLive = options.deferForeignCommitted && foreignLiveOwner
        && liveOwnerTrusted;
      if ((deferCommittedLive || deferForeignLive)
          && !verifiedLifecycleSuccessor(proof, options)) return false;
      if (lstatMaybe(publication.tempPath) !== null) return false;
      if (!cleanupDiscardableProofEntries(publication)) return false;
      if (cleanupPublicationFence(publication)) return true;
      throw recoveryRequired(fencePath);
    }
    if (options.deferFresh
        && !verifiedLifecycleSuccessor(proof, options)
        && (proofOwnerIsAlive(proof) || !fenceIsStale(fencePath, proof))) return false;
    const temp = lstatMaybe(publication.tempPath);
    // A successor may already occupy the canonical name. The unpublished
    // temp and its proof are still private to this transaction and can be
    // released without touching that successor.
    if (publication.expected.exists && lstatMaybe(destPath) === null) return false;
    if (temp === null || exactTemp(publication)) {
      if (temp !== null) unlinkSync(publication.tempPath);
      if (!cleanupDiscardableProofEntries(publication)) return false;
      if (cleanupPublicationFence(publication)) return true;
      throw recoveryRequired(fencePath);
    }
    return false;
  }
  if (options.deferFresh && !fenceIsStale(fencePath)) return false;
  return recoverLegacyFence(destPath, fencePath, identity, options);
}

// Used by generic maintenance after its bounded proof inspection.
export function recoverPublicationFence(destPath, options = {}) {
  const fencePath = `${destPath}${PUBLICATION_FENCE_SUFFIX}`;
  if (directoryIdentity(fencePath) === null) return false;
  return recoverOccupiedFence(destPath, fencePath, options);
}

function beginFence(destPath, expected, options) {
  const path = `${destPath}${PUBLICATION_FENCE_SUFFIX}`;
  let created = false;
  let lastError = null;
  const transientDeadline = Date.now() + FENCE_TRANSIENT_WINDOW_MS;
  for (let attempt = 0; attempt < FENCE_ACQUIRE_RETRIES && !created; attempt += 1) {
    try {
      if (fenceMkdirTransientFailure(attempt)) {
        const error = new Error('test-only transient publication-fence mkdir failure');
        error.code = 'EPERM';
        throw error;
      }
      mkdirSync(path);
      created = true;
      syncParentDirectory(path);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (!FENCE_MKDIR_TRANSIENT_ERRORS.has(error.code) || Date.now() > transientDeadline) {
          throw error;
        }
        // Retry re-enters the loop; the post-loop re-verification (fresh
        // directoryIdentity + expectedDestinationMatches + assertOwnership)
        // covers ownership/generation re-check after any retry.
        runTestInterlock(options, 'publication-fence-wait');
        sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
        continue;
      }
      lastError = error;
      if (!recoverOccupiedFence(destPath, path,
        { ...options, deferFresh: true, deferCommitted: false, deferForeignCommitted: true })) {
        if (attempt === FENCE_ACQUIRE_RETRIES - 1) throw error;
        runTestInterlock(options, 'publication-fence-wait');
        sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
      }
    }
  }
  if (!created) throw lastError || new Error(`unable to acquire publication fence: ${path}`);
  const identity = directoryIdentity(path);
  try {
    const publication = {
      path, identity, oldPath: join(path, FENCE_CHILD),
      expected: expected || captureRegularFileSnapshot(destPath).expectedDestination,
      tempPath: null, tempIdentity: null, published: false,
      proofPath: null, proofIdentity: null, proofContent: null,
    };
    if (!publication.identity || !expectedDestinationMatches(destPath, publication.expected)) {
      throw conflict();
    }
    assertOwnership(options);
    return publication;
  } catch (error) {
    if (created && identity && sameDirectoryIdentity(directoryIdentity(path), identity)) {
      try { if (readdirSync(path).length === 0) rmdirSync(path); } catch { /* preserve proof */ }
    }
    throw error;
  }
}

function persistPublicationProof(publication, destPath, tempPath, tempIdentity, options) {
  publication.tempPath = resolve(tempPath);
  publication.tempIdentity = tempIdentity;
  const snapshot = captureRegularFileSnapshot(tempPath);
  publication.tempDigest = snapshot.contentDigest;
  publication.tempBytes = snapshot.contentBytes;
  const proof = publicationProofFor(
    destPath, tempPath, tempIdentity, publication.expected, publication.path,
    {
      ...options, fenceIdentity: publication.identity,
      tempDigest: snapshot.contentDigest, tempBytes: snapshot.contentBytes,
    },
  );
  writeDurableProof(proofPath(publication.path), proof);
  publication.proof = proof;
  publication.proofPath = proofPath(publication.path);
  publication.proofIdentity = regularFileIdentity(publication.proofPath);
  publication.proofContent = readFileSync(publication.proofPath);
  publication.proofEntries = [{
    path: publication.proofPath,
    identity: publication.proofIdentity,
    content: publication.proofContent,
  }];
}

function markPublicationAbandoned(publication) {
  if (!publication.proof
      || !sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) return;
  const updatedAtMs = Date.now();
  const proof = {
    ...publication.proof, ownerState: 'abandoned', abandonedAtMs: updatedAtMs, updatedAtMs,
  };
  writeDurableProof(publication.proofPath, proof);
  publication.proof = proof;
  publication.proofIdentity = regularFileIdentity(publication.proofPath);
  publication.proofContent = readFileSync(publication.proofPath);
  publication.proofEntries = [{
    path: publication.proofPath,
    identity: publication.proofIdentity,
    content: publication.proofContent,
  }];
}

function publishWithRetry(destPath, tempPath, tempIdentity, expected, publication, options) {
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertOwnership(options);
    if (!sameFileIdentity(regularFileIdentity(tempPath), tempIdentity)) {
      throw new Error('atomic temp file changed concurrently; refusing operation');
    }
    if (!expectedDestinationMatches(destPath, expected)) throw conflict();
    try {
      if (transientRenameFailure(attempt)) {
        const error = new Error('test-only transient rename failure');
        error.code = 'EPERM';
        throw error;
      }
      // This is the sole publication operation. The old canonical entry stays
      // visible until the filesystem performs this atomic replacement.
      renameSync(tempPath, destPath);
      // The rename is the commit point. Everything after it is observability
      // or durability bookkeeping and may fail; rollback callers must enroll
      // this replacement even when that later work throws.
      publication.published = true;
      runTestInterlock(options, 'write-after-rename-before-sync', 'write-post-rename-before-sync');
      syncParentDirectory(destPath);
      return;
    } catch (error) {
      lastError = error;
      // The canonical rename already committed this publication. A failure
      // while syncing its parent is not a rename failure and must retain its
      // original error rather than retrying against a vanished temp inode.
      if (publication.published) throw error;
      if (!transient(error)) throw error;
      runTestInterlock(options, 'rename-retry');
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
    }
  }
  throw lastError;
}

export function publishWithFence(destPath, tempPath, tempIdentity, expected, options = {}) {
  const publication = beginFence(destPath, expected, options);
  try {
    persistPublicationProof(publication, destPath, tempPath, tempIdentity, options);
    // Distinct crash boundary used by recovery tests: the durable proof and
    // payload exist, while the canonical rename has not happened yet.
    runTestInterlock(options, 'write-after-proof-before-final-operation');
    runTestInterlock(options, 'write-before-final-rename');
    runTestInterlock(options, 'write-before-final-operation');
    assertOwnership(options);
    publishWithRetry(
      destPath, tempPath, tempIdentity, publication.expected, publication, options,
    );
    // A crash or lease loss here leaves a complete proof for a successor.
    runTestInterlock(options, 'write-after-final-rename', 'write-after-final-operation');
    assertOwnership(options);
    finishPublication(publication, destPath);
    return publication;
  } catch (error) {
    // Never undo a completed replacement. Its proof remains until a successor
    // verifies the new inode and completes cleanup.
    let committed = publication.published;
    if (!committed) {
      // A failed inspection must never replace the original publication
      // error. The rename path above normally records the commit directly;
      // this fallback only covers unusual callers/filesystems.
      try { committed = destinationIsPublished(publication, destPath); } catch { /* keep original */ }
    }
    if (committed) publication.published = true;
    if (!committed) {
      // A failed abandon or re-inspection must never replace the original
      // publication error either; they only shape the unwind, not its outcome.
      try {
        runTestInterlock(options, 'write-unwind-abandon');
        markPublicationAbandoned(publication);
      } catch { /* keep original */ }
      let provenAbsent = false;
      let inspected = false;
      try {
        runTestInterlock(options, 'write-unwind-reinspect');
        provenAbsent = !destinationIsPublished(publication, destPath);
        inspected = true;
      } catch { /* keep original */ }
      if (!inspected || provenAbsent) {
        // The abort is the one destructive step in this unwind. A throwing
        // abort counts as attempted: the caller's original publication error
        // (commonly AtomicOwnershipLostError) must never be replaced here.
        // (The committed-publication attachment below is inert on this path:
        // it only runs when committed === false, so publication.published is
        // false and attachCommittedPublication() returns immediately.)
        let aborted = false;
        let abortFailed = false;
        try {
          aborted = abortPublication(publication);
        } catch {
          abortFailed = true;
        }
        if (!aborted && !abortFailed && inspected) {
          throw recoveryRequired(publication.path);
        }
      }
    }
    try { attachCommittedPublication(error, publication, destPath); } catch { /* keep original */ }
    throw error;
  }
}
