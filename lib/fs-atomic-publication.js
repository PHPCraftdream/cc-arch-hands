import {
  linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  captureRegularFileSnapshot, directoryIdentity, regularFileIdentity,
  sameDirectoryIdentity, sameFileIdentity,
} from './fs-atomic-identity.js';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const RENAME_RETRIES = 5;
const RENAME_BASE_MS = 20;
export const PUBLICATION_FENCE_SUFFIX = '.cah-owned-publish';
const FENCE_CHILD = 'old';

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
  while (Date.now() < end) { /* keep this synchronous and dependency-free */ }
}

function transient(error) { return RETRY_CODES.has(error.code); }

function directoryIsEmpty(path) {
  try { return readdirSync(path).length === 0; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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

function conflict() {
  return new Error('managed destination leaf changed concurrently; refusing operation');
}

function beginFence(destPath, expected, options) {
  const path = `${destPath}${PUBLICATION_FENCE_SUFFIX}`;
  mkdirSync(path);
  const identity = directoryIdentity(path);
  try {
    const publication = {
      path,
      identity,
      oldPath: join(path, FENCE_CHILD),
      oldIdentity: null,
      expected: expected || captureRegularFileSnapshot(destPath).expectedDestination,
      published: false,
    };
    if (!publication.identity || !expectedDestinationMatches(destPath, publication.expected)) {
      throw conflict();
    }
    assertOwnership(options);
    return publication;
  } catch (error) {
    if (identity && sameDirectoryIdentity(directoryIdentity(path), identity) && directoryIsEmpty(path)) {
      try { rmdirSync(path); } catch { /* keep a changed transaction */ }
    }
    throw error;
  }
}

function moveExpectedToFence(destPath, publication, options) {
  if (!publication.expected.exists) return;
  if (!sameFileIdentity(regularFileIdentity(destPath), publication.expected.identity)) {
    throw conflict();
  }
  moveWithRetry(destPath, publication.oldPath, publication.expected.identity, options);
  publication.oldIdentity = regularFileIdentity(publication.oldPath);
  if (!sameFileIdentity(publication.oldIdentity, publication.expected.identity)) throw conflict();
}

function publishWithoutOverwrite(from, to, sourceIdentity, options) {
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertOwnership(options);
    if (!sameFileIdentity(regularFileIdentity(from), sourceIdentity)) {
      throw new Error('atomic temp file changed concurrently; refusing operation');
    }
    if (lstatMaybe(to) !== null) throw conflict();
    try {
      if (transientRenameFailure(attempt)) {
        const error = new Error('test-only transient rename failure');
        error.code = 'EPERM';
        throw error;
      }
      linkSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error.code === 'EEXIST') throw conflict();
      if (!transient(error)) throw error;
      runTestInterlock(options, 'rename-retry');
      sleepSync(RENAME_BASE_MS * (1 << Math.min(attempt, 4)));
    }
  }
  throw lastError;
}

function moveWithRetry(from, to, sourceIdentity, options) {
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    assertOwnership(options);
    if (!sameFileIdentity(regularFileIdentity(from), sourceIdentity)) throw conflict();
    try {
      if (transientRenameFailure(attempt)) {
        const error = new Error('test-only transient rename failure');
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
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

function exactOld(publication) {
  if (!publication.oldIdentity || !publication.expected.exists) return false;
  if (!sameFileIdentity(regularFileIdentity(publication.oldPath), publication.oldIdentity)) return false;
  const snapshot = captureRegularFileSnapshot(publication.oldPath);
  return snapshot.present
    && sameFileIdentity(snapshot.expectedDestination.identity, publication.expected.identity)
    && (publication.expected.contentDigest === null
      || snapshot.contentDigest === publication.expected.contentDigest)
    && (publication.expected.contentBytes === null
      || snapshot.contentBytes === publication.expected.contentBytes);
}

function discardOld(publication) {
  try { if (exactOld(publication)) unlinkSync(publication.oldPath); } catch { /* preserve proof */ }
}

function restoreOld(destPath, publication) {
  if (!exactOld(publication) || lstatMaybe(destPath) !== null) return false;
  try {
    linkSync(publication.oldPath, destPath);
    unlinkSync(publication.oldPath);
    return true;
  } catch { return false; }
}

function releaseFence(publication) {
  if (!sameDirectoryIdentity(directoryIdentity(publication.path), publication.identity)) return false;
  try {
    if (!directoryIsEmpty(publication.path)) return false;
    rmdirSync(publication.path);
    return true;
  } catch { return false; }
}

function finishFence(publication) {
  if (publication.published) discardOld(publication);
  releaseFence(publication);
}

function recoverFence(destPath, publication, error) {
  if (!publication || publication.published || isOwnershipLoss(error)) return;
  if (publication.oldIdentity) {
    if (lstatMaybe(destPath) === null) restoreOld(destPath, publication);
    if (lstatMaybe(destPath) !== null) discardOld(publication);
  }
  releaseFence(publication);
}

export function publishWithFence(destPath, tempPath, tempIdentity, expected, options = {}) {
  let publication = null;
  publication = beginFence(destPath, expected, options);
  try {
    moveExpectedToFence(destPath, publication, options);
    runTestInterlock(options, 'write-before-final-rename');
    runTestInterlock(options, 'write-before-final-operation');
    assertOwnership(options);
    publishWithoutOverwrite(tempPath, destPath, tempIdentity, options);
    publication.published = true;
    unlinkSync(tempPath);
    finishFence(publication);
  } catch (error) {
    recoverFence(destPath, publication, error);
    throw error;
  }
}
