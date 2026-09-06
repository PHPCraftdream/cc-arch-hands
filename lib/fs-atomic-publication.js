import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync,
  rmdirSync, unlinkSync, writeSync, readFileSync, linkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  captureRegularFileSnapshot, directoryIdentity, regularFileIdentity,
  sameDirectoryIdentity, sameFileIdentity,
} from './fs-atomic-identity.js';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const RENAME_RETRIES = 5;
const RENAME_BASE_MS = 20;
const FENCE_ACQUIRE_RETRIES = 100;
const FENCE_STALE_MS = 1_000;
export const PUBLICATION_FENCE_SUFFIX = '.cah-owned-publish';
export const PUBLICATION_PROOF_FILE = 'publication.json';
const PUBLICATION_PROOF_TEMP = `${PUBLICATION_PROOF_FILE}.tmp`;
const FENCE_CHILD = 'old';
const PUBLICATION_PROOF_VERSION = 2;

export class AtomicOwnershipLostError extends Error {
  constructor() {
    super('ownership lost during atomic filesystem operation');
    this.name = 'AtomicOwnershipLostError';
    this.code = 'ERR_ATOMIC_OWNERSHIP_LOST';
    this.leaseLost = true;
  }
}

function lstatMaybe(path) {
  try { return lstatSync(path, { bigint: true }); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertOwnership(options) {
  const callback = options?.assertOwnership || options?.assertGeneration
    || (typeof options?.generation === 'function' ? options.generation : null);
  if (callback && callback() === false) throw new AtomicOwnershipLostError();
}

function isOwnershipLoss(error) {
  return Boolean(error?.leaseLost
    || error?.code === 'ERR_ATOMIC_OWNERSHIP_LOST'
    || error?.code === 'ERR_BIN_LIFECYCLE_LEASE_LOST');
}

function runTestInterlock(options, ...phases) { options?.testInterlock?.(...phases); }

function transientRenameFailure(attempt) {
  if (process.env.CAH_TEST_ONLY !== '1') return false;
  const count = Number.parseInt(process.env.CAH_TEST_ONLY_FSUTIL_RENAME_TRANSIENT_FAILURES, 10);
  return Number.isSafeInteger(count) && count > attempt;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* synchronous and dependency-free */ }
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

function fenceIsStale(path, proof = null) {
  const proofTime = Number(proof?.createdAtMs);
  if (Number.isSafeInteger(proofTime)) return Date.now() - proofTime >= FENCE_STALE_MS;
  const fenceStat = lstatMaybe(path);
  if (!fenceStat?.mtimeNs || typeof fenceStat.mtimeNs !== 'bigint') return true;
  const fenceTime = Number(fenceStat.mtimeNs / 1_000_000n);
  return Number.isSafeInteger(fenceTime) && Date.now() - fenceTime >= FENCE_STALE_MS;
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

// A proof is the only authority generic maintenance has to act on a non-empty
// publication namespace.
export function readPublicationProof(fencePath) {
  const proof = readJson(proofPath(fencePath)) || readJson(proofTempPath(fencePath));
  if (!proof || proof.version !== PUBLICATION_PROOF_VERSION || typeof proof.destination !== 'string'
      || typeof proof.fencePath !== 'string' || typeof proof.tempPath !== 'string'
      || !proof.fenceIdentity || !proof.tempIdentity || !proof.expected
      || !decodeDirectoryIdentity(proof.fenceIdentity)
      || !decodeExpected(proof.expected)
      || !Number.isSafeInteger(Number(proof.ownerPid))
      || !['active', 'abandoned'].includes(proof.ownerState)) return null;
  return proof;
}

function proofPublication(fencePath, proof) {
  const expected = decodeExpected(proof.expected);
  const tempIdentity = decodeIdentity(proof.tempIdentity);
  const fenceIdentity = decodeDirectoryIdentity(proof.fenceIdentity);
  const currentFenceIdentity = directoryIdentity(fencePath);
  if (!expected || !tempIdentity || !fenceIdentity || !currentFenceIdentity
      || !sameDirectoryIdentity(fenceIdentity, currentFenceIdentity)
      || !samePath(proof.fencePath, fencePath)) return null;
  const proofCandidates = [proofPath(fencePath), proofTempPath(fencePath)];
  const ownedProofPath = proofCandidates.find((candidate) => {
    const candidateProof = readJson(candidate);
    return candidateProof?.transactionId === proof.transactionId;
  });
  const proofIdentity = ownedProofPath ? regularFileIdentity(ownedProofPath) : null;
  if (!ownedProofPath || !proofIdentity) return null;
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
    proofContent: readFileSync(ownedProofPath),
    published: false,
  };
}

function publicationProofFor(destPath, tempPath, tempIdentity, expected, fencePath, options) {
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
    generation: typeof options.generation === 'string'
      ? options.generation : options.publicationGeneration ?? null,
  };
}

function validPublicationProof(fencePath, destPath, proof) {
  const publication = proofPublication(fencePath, proof);
  if (!publication || !publication.identity || !samePath(proof.destination, destPath)
      || !samePath(proof.fencePath, fencePath)
      || dirname(publication.tempPath) !== dirname(resolve(destPath))) return null;
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
  const proofFile = publication.proofPath;
  if (requireProof && (!proofFile || !publication.proofIdentity || !publication.proofContent)) return false;
  const allowed = new Set(requireProof ? [proofFile] : [PUBLICATION_PROOF_FILE, PUBLICATION_PROOF_TEMP]);
  if (entries.some((entry) => !allowed.has(join(publication.path, entry)))) return false;
  if (requireProof && !sameFileIdentity(regularFileIdentity(proofFile), publication.proofIdentity)) return false;
  let proofRemoved = false;
  try {
    for (const entry of entries) {
      unlinkSync(join(publication.path, entry));
      if (join(publication.path, entry) === proofFile) proofRemoved = true;
    }
    rmdirSync(publication.path);
    return true;
  } catch {
    if (requireProof && proofRemoved
        && sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) {
      let fd = null;
      try {
        fd = openSync(proofFile, 'wx', 0o600);
        writeSync(fd, publication.proofContent);
        fsyncSync(fd);
        closeSync(fd);
      } catch {
        if (fd !== null) { try { closeSync(fd); } catch { /* preserve recovery state */ } }
      }
    }
    return false;
  }
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
  if (!cleanupPublicationFence(publication)) throw recoveryRequired(publication.path);
}

function abortPublication(publication) {
  const temp = lstatMaybe(publication.tempPath);
  if (temp !== null && !exactTemp(publication)) return false;
  // The canonical leaf may be a successor by the time an unpublished
  // transaction is unwound. That successor must never be replaced merely to
  // release our private proof fence.
  if (temp !== null) unlinkSync(publication.tempPath);
  return cleanupPublicationFence(publication);
}

function recoverLegacyFence(destPath, fencePath, identity, options) {
  const oldPath = join(fencePath, FENCE_CHILD);
  const old = regularFileIdentity(oldPath);
  if (!old) {
    let entries;
    try { entries = readdirSync(fencePath); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (entries.length === 0 || (entries.length === 1 && entries[0] === PUBLICATION_PROOF_TEMP)) {
      if (!sameDirectoryIdentity(directoryIdentity(fencePath), identity)) return false;
      assertOwnership(options);
      try {
        if (entries.length === 1) unlinkSync(join(fencePath, PUBLICATION_PROOF_TEMP));
        rmdirSync(fencePath);
        return true;
      } catch { return false; }
    }
    return false;
  }
  if (lstatMaybe(destPath) !== null) return false;
  assertOwnership(options);
  try {
    linkSync(oldPath, destPath);
    if (!sameFileIdentity(regularFileIdentity(destPath), old)) return false;
    if (!sameFileIdentity(regularFileIdentity(oldPath), old)) return false;
    unlinkSync(oldPath);
    if (readdirSync(fencePath).length !== 0) return false;
    rmdirSync(fencePath);
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
      if (lstatMaybe(publication.tempPath) !== null) return false;
      if (cleanupPublicationFence(publication)) return true;
      throw recoveryRequired(fencePath);
    }
    if (options.deferFresh && (proofOwnerIsAlive(proof)
      || !fenceIsStale(fencePath, proof))) return false;
    const temp = lstatMaybe(publication.tempPath);
    // A successor may already occupy the canonical name. The unpublished
    // temp and its proof are still private to this transaction and can be
    // released without touching that successor.
    if (publication.expected.exists && lstatMaybe(destPath) === null) return false;
    if (temp === null || exactTemp(publication)) {
      if (temp !== null) unlinkSync(publication.tempPath);
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
  for (let attempt = 0; attempt < FENCE_ACQUIRE_RETRIES && !created; attempt += 1) {
    try {
      mkdirSync(path);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      lastError = error;
      if (!recoverOccupiedFence(destPath, path, { ...options, deferFresh: true })) {
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
}

function markPublicationAbandoned(publication) {
  if (!publication.proof
      || !sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) return;
  const proof = { ...publication.proof, ownerState: 'abandoned', abandonedAtMs: Date.now() };
  try {
    writeDurableProof(publication.proofPath, proof);
    publication.proof = proof;
    publication.proofIdentity = regularFileIdentity(publication.proofPath);
    publication.proofContent = readFileSync(publication.proofPath);
  } catch { /* preserve the original failure and whatever proof remains */ }
}

function publishWithRetry(destPath, tempPath, tempIdentity, expected, options) {
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
      return;
    } catch (error) {
      lastError = error;
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
    runTestInterlock(options, 'write-before-final-rename');
    runTestInterlock(options, 'write-before-final-operation');
    assertOwnership(options);
    publishWithRetry(destPath, tempPath, tempIdentity, publication.expected, options);
    publication.published = true;
    // A crash or lease loss here leaves a complete proof for a successor.
    runTestInterlock(options, 'write-after-final-rename', 'write-after-final-operation');
    assertOwnership(options);
    finishPublication(publication, destPath);
  } catch (error) {
    // Never undo a completed replacement. Its proof remains until a successor
    // verifies the new inode and completes cleanup.
    if (!publication.published) {
      markPublicationAbandoned(publication);
      try {
        if (!destinationIsPublished(publication, destPath)) abortPublication(publication);
      } catch { /* preserve recovery state */ }
    }
    if (isOwnershipLoss(error) && publication.published) throw error;
    throw error;
  }
}
