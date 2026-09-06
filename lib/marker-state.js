import {
  mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync,
  lstatSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  acquireLease, leaseOwned, pathIdentity, releaseLease, samePathIdentity,
  streamDirectoryEntries, removePathIfUnchangedRecoverable, ownerGeneration,
} from './lease-lock.js';
import { captureRegularFileSnapshot, isOlderThan, writeFileAtomic } from './fsutil.js';
import {
  reconcileCapacityStages as reconcileCapacityStageArtifacts,
  reconcileLegacyCapacityFences as reconcileLegacyCapacityFenceArtifacts,
} from './marker-capacity-stage.js';
import { recoverPublicationFence } from './fs-atomic-publication.js';
import {
  casMoveVictim, casRemoveVictim, durableJson,
  compareFreshness, markerMaintenance, payloadProof, preserveMismatch,
  recoverLegacyCapacityState, recoverVictimFence, semanticFreshness, semanticRecord, sourceWins,
  syncBestEffort, victimIdentityKey,
} from './marker-capacity-ops.js';
export { compareFreshness } from './marker-capacity-ops.js';
const TX_VERSION = 2;
const MIGRATION_VERSION = 1;
const ABSENT = 'absent';
const PRESENT = 'present';
const INDETERMINATE = 'indeterminate';
const CAPACITY_STATE_PUBLICATION_FENCE = 'transaction.json.cah-owned-publish';

export const INSPECTION = Object.freeze({ ABSENT, PRESENT, INDETERMINATE });
function testOnlyFailure(name) {
  return process.env.CAH_TEST_ONLY === '1' && process.env[name] === '1';
}
export function inspectPath(path, { content = false } = {}) {
  if (testOnlyFailure('CAH_TEST_ONLY_MARKER_INSPECTION_FAILURE')
      || testOnlyFailure('CAH_TEST_ONLY_CAPACITY_INSPECTION_FAILURE')) {
    return { status: INDETERMINATE, identity: null, content: null };
  }
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: ABSENT, identity: null, content: null };
    return { status: INDETERMINATE, identity: null, content: null, error };
  }
  const identity = pathIdentity(path);
  if (!identity) return { status: INDETERMINATE, identity: null, content: null };
  if (!content || !stat.isFile()) return { status: PRESENT, identity, content: null };
  try {
    return { status: PRESENT, identity, content: readFileSync(path) };
  } catch (error) {
    return { status: INDETERMINATE, identity: null, content: null, error };
  }
}
function identityKey(identity) {
  if (!identity) return null;
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeNs,
    identity.nlink, identity.contentDigest, identity.isFile, identity.isDirectory,
    identity.isSymbolicLink].map((value) => String(value)).join(':');
}
export { identityKey };
export function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}
export function cacheRoot(home) { return join(home, '.claude', 'cah-bin', 'cache'); }
export function markerNamespace(home, namespace) {
  return join(cacheRoot(home), namespace);
}
function configOf(options) {
  return {
    prefix: options.prefix,
    namespace: options.namespace,
    markerDir: options.markerDir,
    ttlMs: options.ttlMs,
    maxSessions: options.maxSessions,
    scanCap: options.scanCap,
    claimTtlMs: options.claimTtlMs,
    ownerTestEnv: options.ownerTestEnv,
    testInterlock: options.testInterlock,
    markerNameRe: options.markerNameRe || new RegExp(`^${escapeRegExp(options.prefix)}[a-f0-9]{64}$`),
    legacyRoots: options.legacyRoots,
  };
}
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function capacityTransactionPath(markerDir) {
  return join(dirname(markerDir), `.${basename(markerDir)}-capacity-transaction`);
}
function capacityStagePath(markerDir) { return join(markerDir, '.capacity-transaction-stage'); }
function capacityStatePath(markerDir) { return join(capacityTransactionPath(markerDir), 'transaction.json'); }
function capacitySlotPath(markerDir) { return join(capacityTransactionPath(markerDir), 'victim'); }
function ownerToken(owner) { return owner?.nonce || owner?.token || null; }
function migrationSentinel(markerDir) { return join(markerDir, '.migration-v1'); }
function claimPath(marker) { return join(dirname(marker), `.cah-marker-claim-${basename(marker)}`); }
function leaseOptions(cfg, phase = 'claim-reclaim') {
  return {
    staleAfterMs: cfg.claimTtlMs,
    fenceSuffix: '.taken-',
    interlockPhase: phase,
    releaseInterlockPhase: phase === 'claim-reclaim' ? 'claim-release' : `${phase}-release`,
    testLeaseEnv: cfg.ownerTestEnv,
    testInterlock: cfg.testInterlock,
  };
}
function markerOwner(nowMs) {
  const token = randomUUID();
  return { pid: process.pid, token, nonce: token, timestamp: nowMs, claimedAt: nowMs };
}
function acquireClaim(marker, nowMs, cfg, phase = 'claim-reclaim') {
  const lease = acquireLease(claimPath(marker), {
    nowMs,
    owner: markerOwner(nowMs),
    ...leaseOptions(cfg, phase),
  });
  return lease ? { marker, claimPath: claimPath(marker), owner: lease.owner, lease } : null;
}

export function markerClaimOwned(claim) { return Boolean(claim?.lease && leaseOwned(claim.lease)); }
export function releaseMarkerClaim(claim) {
  if (!claim?.lease) return false;
  const capacityLease = claim.capacityLease;
  const victimClaim = claim.victimClaim;
  claim.capacityLease = null;
  claim.victimClaim = null;
  try { releaseLease(claim.lease); } finally {
    try { if (victimClaim) releaseMarkerClaim(victimClaim); } finally {
      if (capacityLease) releaseLease(capacityLease);
    }
  }
  return true;
}
function transactionInspection(markerDir, { reconcileEmpty = false,
  recoverPublication = false, assertOwnership = null } = {}) {
  const tx = inspectPath(capacityTransactionPath(markerDir));
  if (tx.status === ABSENT) return { status: ABSENT, state: null };
  if (tx.status === INDETERMINATE || !tx.identity?.isDirectory) {
    return { status: INDETERMINATE, state: null };
  }
  let state = inspectPath(capacityStatePath(markerDir), { content: true });
  if (state.status === ABSENT) {
    const statePath = capacityStatePath(markerDir);
    const publicationFence = inspectPath(join(dirname(statePath), CAPACITY_STATE_PUBLICATION_FENCE));
    if (publicationFence.status === INDETERMINATE) {
      return { status: INDETERMINATE, state: null };
    }
    if (publicationFence.status === PRESENT && recoverPublication) {
      try {
        const legacy = recoverLegacyCapacityState(markerDir, statePath,
          join(dirname(statePath), CAPACITY_STATE_PUBLICATION_FENCE), assertOwnership, {
            inspectPath, capacitySlotPath, parseTransactionState, identityKey,
            present: PRESENT, indeterminate: INDETERMINATE,
          });
        state = inspectPath(statePath, { content: true });
        // A recognized capacity proof that cannot re-establish its exact
        // transaction is an occupied recovery state. Never fall through and
        // parse a foreign successor at transaction.json as if it were ours.
        if (legacy.recognized && !legacy.state) {
          return { status: INDETERMINATE, state: null };
        }
        if (state.status === ABSENT && !legacy.recognized) {
          recoverPublicationFence(statePath, { assertOwnership });
          state = inspectPath(statePath, { content: true });
        }
      } catch { return { status: INDETERMINATE, state: null }; }
    }
    const currentFence = inspectPath(join(dirname(statePath), CAPACITY_STATE_PUBLICATION_FENCE));
    if (currentFence.status === INDETERMINATE
        || (currentFence.status === PRESENT && state.status === ABSENT)) {
      return { status: INDETERMINATE, state: null };
    }
    const fenced = inspectPath(join(dirname(statePath), CAPACITY_STATE_PUBLICATION_FENCE, 'old'), {
      content: true,
    });
    if (fenced.status === PRESENT && fenced.identity?.isFile) state = fenced;
  }
  if (state.status === ABSENT && reconcileEmpty) {
    try {
      const transactionPath = capacityTransactionPath(markerDir);
      if (readdirSync(transactionPath).length === 0
          && typeof assertOwnership === 'function' && assertOwnership()) {
        const current = inspectPath(transactionPath);
        if (current.status !== PRESENT || !current.identity?.isDirectory
            || identityKey(current.identity) !== identityKey(tx.identity)
            || !assertOwnership()) return { status: INDETERMINATE, state: null };
        rmdirSync(transactionPath);
        syncBestEffort(dirname(transactionPath));
        return { status: ABSENT, state: null };
      }
    } catch { return { status: INDETERMINATE, state: null }; }
  }
  try {
    const entries = readdirSync(capacityTransactionPath(markerDir));
    if (entries.some((name) => name !== 'transaction.json' && name !== 'victim'
        && !name.startsWith('.cah-tmp-') && name !== CAPACITY_STATE_PUBLICATION_FENCE)) {
      return { status: INDETERMINATE, state: null };
    }
  } catch { return { status: INDETERMINATE, state: null }; }
  if (state.status !== PRESENT || !state.identity?.isFile) {
    return { status: state.status === ABSENT ? INDETERMINATE : state.status, state: null };
  }
  const parsed = parseTransactionState(state.content);
  return parsed ? { status: PRESENT, state: parsed }
    : { status: INDETERMINATE, state: null };
}

function parseTransactionState(content) {
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    if (parsed?.version !== TX_VERSION || typeof parsed.marker !== 'string'
        || typeof parsed.victim !== 'string' || typeof parsed.victimKey !== 'string'
        || typeof parsed.markerBeforeKey !== 'string' || typeof parsed.nonce !== 'string'
        || typeof parsed.markerClaimPath !== 'string' || typeof parsed.victimClaimPath !== 'string'
        || typeof parsed.capacityLeasePath !== 'string') return null;
    for (const key of ['capacityLeaseGeneration', 'sessionLeaseGeneration', 'victimLeaseGeneration']) {
      if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || !parsed[key])) return null;
    }
    return parsed;
  } catch { return null; }
}
function readTransaction(markerDir, options = {}) {
  const result = transactionInspection(markerDir, options);
  return result.status === ABSENT ? undefined : result.status === PRESENT ? result.state : null;
}
function capacityLeaseAssertion(capacityLease) {
  const path = capacityLease?.path || null;
  const token = ownerToken(capacityLease?.owner);
  const generation = ownerGeneration(capacityLease?.owner);
  return () => Boolean(capacityLease && path && token && generation
    && capacityLease.path === path
    && ownerToken(capacityLease.owner) === token
    && ownerGeneration(capacityLease.owner) === generation
    && leaseOwned(capacityLease));
}
function acquireCapacityLeaseForPrune(markerDir, cfg, nowMs) {
  const path = join(markerDir, `.cah-marker-capacity-${cfg.namespace}`);
  const options = { nowMs, ...leaseOptions(cfg, 'marker-capacity-lease-reclaim') };
  const acquired = acquireLease(path, options);
  if (acquired) return { lease: acquired, borrowed: false };
  const ownerState = inspectPath(join(path, 'owner.json'), { content: true });
  if (ownerState.status !== PRESENT || !ownerState.identity?.isFile) return null;
  let owner;
  try { owner = JSON.parse(ownerState.content.toString('utf8')); } catch { return null; }
  if (owner?.pid !== process.pid || !ownerGeneration(owner)
      || !Number.isFinite(owner.timestamp)
      || nowMs < owner.timestamp || nowMs - owner.timestamp > (cfg.claimTtlMs ?? 30_000)) return null;
  return {
    lease: { path, owner, options },
    borrowed: true,
  };
}
function reconcileCapacityStages(markerDir, cfg, capacityLease) {
  return reconcileCapacityStageArtifacts(markerDir, cfg, {
    inspectPath, parseTransactionState, capacityTransactionPath, capacityStagePath,
    assertCapacityLease: capacityLease ? capacityLeaseAssertion(capacityLease) : null,
  });
}
function transactionLeaseValid(state, context, { requireSession = true } = {}) {
  if (!state || !context?.capacityLease || !leaseOwned(context.capacityLease)) return false;
  if ((!context.recovered && ownerToken(context.capacityLease.owner) !== state.capacityLeaseToken)
      || context.capacityLease.path !== state.capacityLeasePath) return false;
  if (!context.recovered && state.capacityLeaseGeneration
      && ownerGeneration(context.capacityLease.owner) !== state.capacityLeaseGeneration) return false;
  if (requireSession && (!context.sessionClaim?.lease || !leaseOwned(context.sessionClaim.lease)
      || (!context.recovered && ownerToken(context.sessionClaim.lease.owner) !== state.sessionLeaseToken)
      || context.sessionClaim.lease.path !== state.markerClaimPath)) return false;
  if (requireSession && !context.recovered && state.sessionLeaseGeneration
      && ownerGeneration(context.sessionClaim.lease.owner) !== state.sessionLeaseGeneration) return false;
  if (context.victimClaim
      && (!leaseOwned(context.victimClaim.lease)
        || (!context.recovered && ownerToken(context.victimClaim.lease.owner) !== state.victimLeaseToken)
        || context.victimClaim.lease.path !== state.victimClaimPath)) return false;
  if (context.victimClaim && !context.recovered && state.victimLeaseGeneration
      && ownerGeneration(context.victimClaim.lease.owner) !== state.victimLeaseGeneration) return false;
  return true;
}
function transactionStillCurrent(markerDir, state, context, options = {}) {
  if (!state?.capacityLeaseGeneration || !transactionLeaseValid(state, context, options)) return false;
  const current = transactionInspection(markerDir);
  return current.status === PRESENT && current.state.nonce === state.nonce
    && current.state.capacityLeaseGeneration === state.capacityLeaseGeneration
    && current.state.victimFenceGeneration === state.victimFenceGeneration;
}
function capacityOps() {
  return {
    transactionStillCurrent, inspectPath, identityKey,
    present: PRESENT, absent: ABSENT, indeterminate: INDETERMINATE,
  };
}
function finishStatePublication(markerDir, state, context) {
  const statePath = capacityStatePath(markerDir);
  const fencePath = join(dirname(statePath), CAPACITY_STATE_PUBLICATION_FENCE);
  const fence = inspectPath(fencePath);
  if (fence.status === INDETERMINATE) return false;
  if (fence.status === ABSENT) return true;
  try {
    const recovered = recoverPublicationFence(statePath, {
      assertOwnership: () => {
        if (!transactionStillCurrent(markerDir, state, context)) {
          throw new Error('capacity transaction changed during publication recovery');
        }
      },
    });
    return recovered && inspectPath(fencePath).status === ABSENT;
  } catch { return false; }
}
function publicationStatus(state) {
  const marker = inspectPath(state.marker, { content: true });
  if (marker.status === INDETERMINATE) return INDETERMINATE;
  if (marker.status === ABSENT || !marker.identity?.isFile) return ABSENT;
  if (identityKey(marker.identity) === state.markerBeforeKey) return ABSENT;
  if (state.expectedPayloadDigest) {
    const proof = payloadProof(marker.content);
    if (proof?.digest === state.expectedPayloadDigest
        && (!state.expectedPayloadSemantic
          || JSON.stringify(proof.semantic) === JSON.stringify(state.expectedPayloadSemantic))) return PRESENT;
    return INDETERMINATE;
  }
  const record = semanticRecord(marker.content);
  let parsed = null;
  try { parsed = JSON.parse(marker.content.toString('utf8')); } catch { /* legacy payload */ }
  if (parsed && ownerToken(parsed) === state.nonce) return PRESENT;
  if (state.markerBeforeKey === 'absent' && record.time === null) return PRESENT;
  return state.markerPublishedKey && identityKey(marker.identity) === state.markerPublishedKey
    ? PRESENT : INDETERMINATE;
}

function cleanupTransaction(markerDir, state, context) {
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const txPath = capacityStatePath(markerDir);
  const tx = inspectPath(txPath, { content: true });
  if (tx.status !== PRESENT || !samePathIdentity(tx.identity, pathIdentity(txPath))) return false;
  try {
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    if (!finishStatePublication(markerDir, state, context)) return false;
    if (!recoverVictimFences(markerDir, state, context)) return false;
    const remainingSlot = inspectPath(capacitySlotPath(markerDir));
    if (remainingSlot.status !== ABSENT) return false;
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    const finalState = inspectPath(txPath, { content: true });
    if (finalState.status !== PRESENT || !samePathIdentity(tx.identity, finalState.identity)
        || identityKey(finalState.identity) !== identityKey(tx.identity)) return false;
    const persisted = parseTransactionState(finalState.content);
    const txDir = capacityTransactionPath(markerDir);
    const entries = readdirSync(txDir);
    if (!persisted?.capacityLeaseGeneration || persisted.nonce !== state.nonce
        || entries.some((name) => name !== 'transaction.json')) return false;
    // This is the final ownership and exact-identity check before removing
    // transaction.json. Any successor or recovery artifact leaves the record.
    const unlinkState = inspectPath(txPath, { content: true });
    if (unlinkState.status !== PRESENT || identityKey(unlinkState.identity) !== identityKey(tx.identity)
        || !parseTransactionState(unlinkState.content)?.capacityLeaseGeneration
        || !transactionStillCurrent(markerDir, state, context)) return false;
    unlinkSync(txPath);
    syncBestEffort(capacityTransactionPath(markerDir));
    const dir = inspectPath(txDir);
    if (dir.status === INDETERMINATE) return false;
    if (dir.status === PRESENT) {
      const finalDir = inspectPath(txDir);
      if (finalDir.status !== PRESENT || !finalDir.identity?.isDirectory
          || identityKey(finalDir.identity) !== identityKey(dir.identity)
          || !transactionLeaseValid(state, context)
          || readdirSync(txDir).length !== 0) return false;
      rmdirSync(txDir);
      syncBestEffort(dirname(txDir));
    }
    return true;
  } catch { return false; }
}
function recoverVictimFences(markerDir, state, context) {
  for (const sourcePath of [state.victim, capacitySlotPath(markerDir)]) {
    if (!recoverVictimFence(markerDir, state, context, sourcePath, capacityOps())) return false;
  }
  return true;
}
function restoreVictim(markerDir, state, context) {
  if (!recoverVictimFences(markerDir, state, context)) return false;
  const slot = inspectPath(capacitySlotPath(markerDir));
  const canonical = inspectPath(state.victim, { content: true });
  if (slot.status === INDETERMINATE || canonical.status === INDETERMINATE) return false;
  if (slot.status === ABSENT) return canonical.status === PRESENT;
  if (canonical.status === ABSENT) {
    return casMoveVictim(markerDir, state, context, capacitySlotPath(markerDir), state.victim,
      null, capacityOps());
  }
  const victimFresh = semanticFreshness(state.victim, slot);
  const successorFresh = semanticFreshness(state.victim, canonical);
  if (compareFreshness(successorFresh, victimFresh) === null
      || compareFreshness(successorFresh, victimFresh) < 0) return false;
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const currentCanonical = inspectPath(state.victim);
  if (currentCanonical.status !== PRESENT
      || identityKey(currentCanonical.identity) !== identityKey(canonical.identity)) {
    preserveMismatch(context, state.victim, identityKey(canonical.identity),
      currentCanonical.status === PRESENT ? identityKey(currentCanonical.identity) : currentCanonical.status);
    return false;
  }
  return casRemoveVictim(markerDir, state, context, capacitySlotPath(markerDir), capacityOps());
}

export function finishCapacityEviction(markerDir, state, context) {
  if (!state || !transactionStillCurrent(markerDir, state, context)) return false;
  const publication = publicationStatus(state);
  if (publication === INDETERMINATE || publication !== PRESENT) return false;
  try {
    if (!recoverVictimFences(markerDir, state, context)) return false;
    const slot = inspectPath(capacitySlotPath(markerDir));
    if (slot.status === INDETERMINATE) return false;
    if (slot.status === ABSENT) {
      const victim = inspectPath(state.victim);
      if (victim.status === INDETERMINATE) return false;
      if (victim.status === PRESENT) {
        if (!casMoveVictim(markerDir, state, context, state.victim,
          capacitySlotPath(markerDir), null, capacityOps())) return false;
      }
    }
    if (testOnlyFailure('CAH_TEST_ONLY_FINAL_UNLINK_FAILURE')
        || testOnlyFailure('CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE')
        || testOnlyFailure('CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE')) return false;
    const finalSlot = inspectPath(capacitySlotPath(markerDir));
    if (finalSlot.status === INDETERMINATE) return false;
    if (finalSlot.status === PRESENT) {
      if (!casRemoveVictim(markerDir, state, context, capacitySlotPath(markerDir), capacityOps())) return false;
    }
    return cleanupTransaction(markerDir, state, context);
  } catch { return false; }
}

export function abortCapacityEviction(markerDir, state, context) {
  if (!state) return true;
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const publication = publicationStatus(state);
  if (publication === INDETERMINATE) return false;
  if (publication === PRESENT) return finishCapacityEviction(markerDir, state, context);
  if (!restoreVictim(markerDir, state, context)) return false;
  return cleanupTransaction(markerDir, state, context);
}
function recoverCapacityTransaction(markerDir, state, capacityLease, nowMs, cfg, maintenance = null) {
  const sessionLease = acquireLease(state.markerClaimPath, { nowMs, ...leaseOptions(cfg, 'claim-reclaim') });
  const victimLease = acquireLease(state.victimClaimPath, { nowMs, ...leaseOptions(cfg, 'claim-reclaim') });
  if (!sessionLease || !victimLease) {
    if (sessionLease) releaseLease(sessionLease);
    if (victimLease) releaseLease(victimLease);
    return false;
  }
  const context = {
    capacityLease, recovered: true,
    maintenance,
    testInterlock: cfg.testInterlock,
    sessionClaim: { marker: state.marker, claimPath: state.markerClaimPath, owner: sessionLease.owner, lease: sessionLease },
    victimClaim: { marker: state.victim, claimPath: state.victimClaimPath, owner: victimLease.owner, lease: victimLease },
  };
  try { return abortCapacityEviction(markerDir, state, context); }
  finally {
    releaseMarkerClaim(context.sessionClaim);
    releaseMarkerClaim(context.victimClaim);
  }
}
function persistPayloadProof(markerDir, state, context, payload) {
  const proof = payloadProof(payload);
  if (!proof) return true;
  if (state.expectedPayloadDigest === proof.digest
      && JSON.stringify(state.expectedPayloadSemantic) === JSON.stringify(proof.semantic)) return true;
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const path = capacityStatePath(markerDir);
  const current = captureRegularFileSnapshot(path);
  if (!current.present) return false;
  const next = { ...state, expectedPayloadDigest: proof.digest, expectedPayloadSemantic: proof.semantic };
  try {
    writeFileAtomic(path, JSON.stringify(next) + '\n', {
      createParents: false, expectedDestination: current.expectedDestination,
      testInterlock: context.testInterlock,
      assertOwnership: () => transactionStillCurrent(markerDir, state, context),
    });
    Object.assign(state, next);
    return transactionStillCurrent(markerDir, state, context);
  } catch { return false; }
}

function reconcileLegacyCapacityFences(markerDir, cfg, capacityLease) {
  return reconcileLegacyCapacityFenceArtifacts(markerDir, cfg, capacityLease, {
    inspectPath, sourceWins, capacityLeaseAssertion,
  });
}

function scanCapacity(markerDir, cfg, marker, excludedPath, nowMs) {
  let count = 0;
  let oldest = null;
  let indeterminate = false;
  const scan = streamDirectoryEntries(markerDir, cfg.scanCap, (entry) => {
    if (!cfg.markerNameRe.test(entry.name) || !entry.isFile()) return;
    const path = join(markerDir, entry.name);
    if (path === marker || path === excludedPath) return;
    const inspected = inspectPath(path);
    if (inspected.status === INDETERMINATE) { indeterminate = true; return; }
    if (inspected.status === PRESENT && inspected.identity?.isFile
        && !isOlderThan(inspected.identity, nowMs, cfg.ttlMs)) {
      count += 1;
      if (!oldest || inspected.identity.mtimeNs < oldest.identity.mtimeNs) {
        oldest = { path, identity: inspected.identity };
      }
    }
  });
  return { count, oldest, complete: scan.complete && !indeterminate };
}

function prepareCapacityEviction(markerDir, marker, markerBefore, nonce, nowMs, cfg, context,
  excludedPath = null, expectedPayload = null) {
  if (!reconcileCapacityStages(markerDir, cfg, context?.capacityLease)) return null;
  const tx = readTransaction(markerDir, { reconcileEmpty: true, recoverPublication: true,
    assertOwnership: capacityLeaseAssertion(context.capacityLease) });
  if (tx === null) return null;
  if (tx) {
    if (!transactionLeaseValid(tx, context)) return null;
    if (!abortCapacityEviction(markerDir, tx, context)) return null;
  }
  if (!reconcileLegacyCapacityFences(markerDir, cfg, context.capacityLease)) return null;
  const scan = scanCapacity(markerDir, cfg, marker, excludedPath, nowMs);
  if (!scan.complete) return null;
  if (scan.count < cfg.maxSessions || !scan.oldest) return { state: null, victimClaim: null };
  const victimClaim = acquireClaim(scan.oldest.path, nowMs, cfg);
  if (!victimClaim) return null;
  const txDir = capacityTransactionPath(markerDir);
  const proof = payloadProof(expectedPayload);
  const state = {
    version: TX_VERSION,
    marker,
    markerBeforeKey: identityKey(markerBefore) || 'absent',
    nonce,
    victim: scan.oldest.path,
    victimKey: identityKey(scan.oldest.identity),
    victimStableKey: victimIdentityKey(scan.oldest.identity),
    markerClaimPath: context.sessionClaim.lease.path,
    markerClaimToken: ownerToken(context.sessionClaim.owner),
    sessionLeaseToken: ownerToken(context.sessionClaim.owner),
    victimClaimPath: victimClaim.claimPath,
    victimLeaseToken: ownerToken(victimClaim.owner),
    capacityLeasePath: context.capacityLease.path,
    capacityLeaseToken: ownerToken(context.capacityLease.owner),
    capacityLeaseGeneration: ownerGeneration(context.capacityLease.owner),
    victimFenceGeneration: ownerGeneration(context.capacityLease.owner),
    sessionLeaseGeneration: ownerGeneration(context.sessionClaim.owner),
    victimLeaseGeneration: ownerGeneration(victimClaim.owner),
    preparedAt: nowMs,
    ...(proof ? { expectedPayloadDigest: proof.digest, expectedPayloadSemantic: proof.semantic } : {}),
  };
  try {
    const existing = transactionInspection(markerDir, { reconcileEmpty: true });
    if (existing.status !== ABSENT) throw new Error('capacity transaction already exists');
    const stageDir = capacityStagePath(markerDir);
    mkdirSync(stageDir, { mode: 0o700 });
    syncBestEffort(dirname(stageDir));
    try {
      if (!durableJson(join(stageDir, 'transaction.json'), state)) throw new Error('transaction state write failed');
      syncBestEffort(stageDir);
      if (testOnlyFailure('CAH_TEST_ONLY_CAPACITY_CRASH_AFTER_STAGE_WRITE')) process.exit(92);
      renameSync(stageDir, txDir);
      syncBestEffort(dirname(stageDir));
      syncBestEffort(dirname(txDir));
      syncBestEffort(txDir);
    } catch (error) {
      try {
        rmdirSync(stageDir);
        syncBestEffort(dirname(stageDir));
      } catch { /* preserve non-empty or indeterminate stage */ }
      throw error;
    }
    const victim = inspectPath(scan.oldest.path);
    if (victim.status !== PRESENT || !samePathIdentity(scan.oldest.identity, victim.identity)
        || !transactionStillCurrent(markerDir, state, context)) throw new Error('victim changed');
    cfg.testInterlock?.('marker-capacity', 'before');
    if (!casMoveVictim(markerDir, state, context, scan.oldest.path,
      capacitySlotPath(markerDir), null,
      capacityOps())) {
      restoreVictim(markerDir, state, context);
      cleanupTransaction(markerDir, state, context);
      releaseMarkerClaim(victimClaim);
      return prepareCapacityEviction(markerDir, marker, markerBefore, nonce, nowMs, cfg, context,
        scan.oldest.path, expectedPayload);
    }
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-victim-rename'
          || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-victim-rename')) process.exit(93);
    return { state, victimClaim };
  } catch {
    try {
      const current = readTransaction(markerDir);
      if (current && current.nonce === state.nonce) {
        restoreVictim(markerDir, current, context);
        if (inspectPath(capacitySlotPath(markerDir)).status === ABSENT) cleanupTransaction(markerDir, current, context);
      }
    } catch { /* leave a recoverable transaction */ }
    releaseMarkerClaim(victimClaim);
    return null;
  }
}

function migrationCollision(sourcePath, targetPath, source) {
  const target = inspectPath(targetPath, { content: true });
  if (target.status === INDETERMINATE) return { status: INDETERMINATE };
  if (target.status === ABSENT) return { status: ABSENT };
  const winner = sourceWins(source, target);
  if (winner === null) return { status: INDETERMINATE };
  return { status: PRESENT, winner: winner ? 'source' : 'target', target };
}

function removeSourceIfUnchanged(sourcePath, sourceIdentity) {
  const current = inspectPath(sourcePath);
  if (current.status !== PRESENT || !samePathIdentity(sourceIdentity, current.identity)) return false;
  try { unlinkSync(sourcePath); return true; } catch { return false; }
}

function migrateFile(sourcePath, targetPath, cfg, sourceIdentity, capacityContext = null) {
  const source = inspectPath(sourcePath, { content: true });
  if (source.status !== PRESENT || !source.identity?.isFile) return source.status;
  if (resolve(sourcePath) === resolve(targetPath)) return PRESENT;
  const collision = migrationCollision(sourcePath, targetPath, source);
  if (collision.status === INDETERMINATE) return INDETERMINATE;
  if (collision.status === PRESENT && collision.winner === 'target') {
    removeSourceIfUnchanged(sourcePath, sourceIdentity);
    return PRESENT;
  }
  let migrationClaim = null;
  let migrationTransaction = null;
  let migrationContext = null;
  try {
    const expected = collision.status === ABSENT ? { exists: false } : captureRegularFileSnapshot(targetPath).expectedDestination;
    if (collision.status === ABSENT && capacityContext?.capacityLease) {
      migrationClaim = acquireClaim(targetPath, Date.now(), cfg);
      if (!migrationClaim) return INDETERMINATE;
      migrationContext = { capacityLease: capacityContext.capacityLease, sessionClaim: migrationClaim };
      migrationTransaction = prepareCapacityEviction(
        dirname(targetPath), targetPath, null, ownerToken(migrationClaim.owner), Date.now(), cfg,
        migrationContext, null, source.content,
      );
      if (!migrationTransaction) return INDETERMINATE;
      migrationClaim.victimClaim = migrationTransaction.victimClaim;
      migrationContext.victimClaim = migrationTransaction.victimClaim;
      expected.exists = false;
    }
    writeFileAtomic(targetPath, source.content, {
      expectedDestination: expected,
      assertOwnership: () => !capacityContext || Boolean(
        capacityContext.capacityLease && leaseOwned(capacityContext.capacityLease)
        && (!migrationClaim || markerClaimOwned(migrationClaim))
        && (!migrationTransaction?.state
          || transactionStillCurrent(dirname(targetPath), migrationTransaction.state, migrationContext))),
    });
    if (migrationTransaction?.state) {
      const published = inspectPath(targetPath);
      if (published.status !== PRESENT) throw new Error('migrated marker disappeared');
      migrationTransaction.state.markerPublishedKey = identityKey(published.identity);
      if (!finishCapacityEviction(dirname(targetPath), migrationTransaction.state, migrationContext)) {
        throw new Error('migrated capacity transaction not committed');
      }
    }
    removeSourceIfUnchanged(sourcePath, sourceIdentity);
    return PRESENT;
  } catch (error) {
    if (migrationTransaction?.state) abortCapacityEviction(dirname(targetPath), migrationTransaction.state, migrationContext);
    return INDETERMINATE;
  } finally {
    if (migrationClaim) releaseMarkerClaim(migrationClaim);
  }
}

function migrateClaim(sourcePath, targetPath, cfg) {
  const source = inspectPath(sourcePath, { content: true });
  const target = inspectPath(targetPath, { content: true });
  if (source.status === INDETERMINATE || target.status === INDETERMINATE) return INDETERMINATE;
  if (source.status === ABSENT) return ABSENT;
  if (resolve(sourcePath) === resolve(targetPath)) return PRESENT;
  if (!source.identity?.isDirectory) return INDETERMINATE;
  if (target.status === ABSENT) {
    try { renameSync(sourcePath, targetPath); return PRESENT; } catch { return INDETERMINATE; }
  }
  if (!target.identity?.isDirectory) return INDETERMINATE;
  const sourceOwner = inspectPath(join(sourcePath, 'owner.json'), { content: true });
  const targetOwner = inspectPath(join(targetPath, 'owner.json'), { content: true });
  if (sourceOwner.status === INDETERMINATE || targetOwner.status === INDETERMINATE) return INDETERMINATE;
  const sourceFresh = semanticFreshness(sourcePath, sourceOwner);
  const targetFresh = semanticFreshness(targetPath, targetOwner);
  const winner = compareFreshness(sourceFresh, targetFresh);
  if (winner === null) return INDETERMINATE;
  if (winner > 0) {
    const sourceLease = acquireLease(sourcePath, leaseOptions(cfg, 'legacy-claim-reclaim'));
    if (!sourceLease) return INDETERMINATE;
    const targetLease = acquireLease(targetPath, leaseOptions(cfg, 'legacy-claim-reclaim'));
    if (!targetLease) { releaseLease(sourceLease); return INDETERMINATE; }
    let moved = false;
    try {
      if (!releaseLease(targetLease)) return INDETERMINATE;
      if (inspectPath(targetPath).status !== ABSENT) return INDETERMINATE;
      renameSync(sourcePath, targetPath);
      moved = true;
      return PRESENT;
    } catch { return INDETERMINATE; }
    finally { if (moved) releaseLease(sourceLease); }
  }
  const old = acquireLease(sourcePath, leaseOptions(cfg, 'legacy-claim-reclaim'));
  if (!old) return INDETERMINATE;
  releaseLease(old);
  return PRESENT;
}

function directName(prefix, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || /[\\/\0]/.test(sessionId)) return null;
  return `${prefix}${sessionId}`;
}

function migrationCandidates(home, cfg, sessionId) {
  const hashName = `${cfg.prefix}${sessionHash(sessionId)}`;
  const rawName = directName(cfg.prefix, sessionId);
  const claimPrefix = '.cah-marker-claim-';
  const direct = [
    { source: `${cfg.prefix}${sessionHash(sessionId)}`, target: hashName, claim: false },
    ...(rawName ? [{ source: rawName, target: hashName, claim: false }] : []),
    { source: `${claimPrefix}${hashName}`, target: `${claimPrefix}${hashName}`, claim: true },
    ...(rawName ? [{ source: `${claimPrefix}${rawName}`, target: `${claimPrefix}${hashName}`, claim: true }] : []),
  ];
  return direct;
}

function scanLegacyRoot(root, scanCap, onEntry) {
  const inspected = inspectPath(root);
  if (inspected.status === ABSENT) return { visited: 0, complete: true };
  if (inspected.status !== PRESENT || !inspected.identity?.isDirectory) {
    return { visited: 0, complete: false };
  }
  return streamDirectoryEntries(root, scanCap, onEntry);
}

export function migrateMarkerState(options) {
  const cfg = configOf(options);
  const { home, sessionId } = options;
  const markerDir = cfg.markerDir || markerNamespace(home, cfg.namespace);
  try { mkdirSync(markerDir, { recursive: true }); } catch { return { blocked: true }; }

  const roots = [...new Set((cfg.legacyRoots || [cacheRoot(home), join(home, '.claude')])
    .filter((root) => root && resolve(root) !== resolve(markerDir)))];
  let blocked = false;
  const sentinel = migrationSentinel(markerDir);
  const migrationLease = acquireLease(join(markerDir, `.cah-marker-capacity-${cfg.namespace}`), {
    nowMs: Date.now(), ...leaseOptions(cfg, 'marker-capacity-lease-reclaim'),
  });
  if (!migrationLease) return { blocked: true };
  try {
    if (!reconcileCapacityStages(markerDir, cfg, migrationLease)) return { blocked: true };
    const transaction = readTransaction(markerDir, { reconcileEmpty: true, recoverPublication: true,
      assertOwnership: capacityLeaseAssertion(migrationLease) });
    if (transaction === null
        || (transaction && !recoverCapacityTransaction(markerDir, transaction, migrationLease, Date.now(), cfg))) {
      return { blocked: true };
    }
    for (const candidate of migrationCandidates(home, cfg, sessionId)) {
      for (const root of roots) {
        const sourcePath = join(root, candidate.source);
        const targetPath = join(markerDir, candidate.target);
        const source = inspectPath(sourcePath, { content: !candidate.claim });
        if (source.status === ABSENT) continue;
        if (source.status === INDETERMINATE) { blocked = true; continue; }
        if (candidate.claim) {
          if (migrateClaim(sourcePath, targetPath, cfg) === INDETERMINATE) blocked = true;
        } else if (migrateFile(sourcePath, targetPath, cfg, source.identity, { capacityLease: migrationLease }) === INDETERMINATE) blocked = true;
      }
    }
    if (inspectPath(sentinel).status === PRESENT) return { blocked };
    let legacyScanComplete = true;
    for (const root of roots) {
      const scan = scanLegacyRoot(root, cfg.scanCap, (entry) => {
        if (entry.name === basename(markerDir) || entry.name === '.migration-v1') return;
        const suffix = entry.name.startsWith(cfg.prefix) ? entry.name.slice(cfg.prefix.length) : null;
        const claimPrefix = `.cah-marker-claim-${cfg.prefix}`;
        const claimSuffix = entry.name.startsWith(claimPrefix) ? entry.name.slice(claimPrefix.length) : null;
        if (suffix && /^[a-f0-9]{64}$/.test(suffix) && entry.isFile()) {
          const sourcePath = join(root, entry.name);
          const targetPath = join(markerDir, entry.name);
          const source = inspectPath(sourcePath, { content: true });
          if (source.status === INDETERMINATE) { blocked = true; return; }
          if (source.status === PRESENT
              && migrateFile(sourcePath, targetPath, cfg, source.identity, { capacityLease: migrationLease }) === INDETERMINATE) blocked = true;
        } else if (claimSuffix && /^[a-f0-9]{64}$/.test(claimSuffix) && entry.isDirectory()) {
          const result = migrateClaim(join(root, entry.name), join(markerDir, entry.name), cfg);
          if (result === INDETERMINATE) blocked = true;
        }
      });
      if (!scan.complete) legacyScanComplete = false;
    }
    if (!blocked && legacyScanComplete) {
      try { writeFileSync(sentinel, `v${MIGRATION_VERSION}\n`, { flag: 'wx' }); } catch { /* another worker won */ }
    }
  } finally { releaseLease(migrationLease); }
  return { blocked };
}

export function migrateLegacyStateFiles(options) {
  const cfg = configOf(options);
  const { home, sessionId, namespaceDir, stateName, lockName, prefix } = options;
  const namespace = namespaceDir;
  try { mkdirSync(namespace, { recursive: true }); } catch { return { blocked: true }; }
  const roots = [...new Set((options.roots || [dirname(namespace), cacheRoot(home)])
    .filter((root) => root && resolve(root) !== resolve(namespace)))];
  let blocked = false;
  const migrateRoot = (root, name, isClaim) => {
    const sourcePath = join(root, name);
    const targetPath = join(namespace, name);
    const source = inspectPath(sourcePath, { content: !isClaim });
    if (source.status === ABSENT) return;
    if (source.status === INDETERMINATE) { blocked = true; return; }
    const result = isClaim
      ? migrateClaim(sourcePath, targetPath, cfg)
      : migrateFile(sourcePath, targetPath, cfg, source.identity);
    if (result === INDETERMINATE) blocked = true;
  };
  for (const root of roots) {
    migrateRoot(root, stateName, false);
    migrateRoot(root, lockName, true);
  }
  const sentinel = migrationSentinel(namespace);
  if (inspectPath(sentinel).status === PRESENT) return { blocked };
  let legacyScanComplete = true;
  for (const root of roots) {
    const scan = scanLegacyRoot(root, options.scanCap, (entry) => {
      if (!entry.name.startsWith(prefix)) return;
      if (entry.name.endsWith('.json.lock') && entry.isDirectory()) migrateRoot(root, entry.name, true);
      else if (entry.name.endsWith('.json') && entry.isFile()) migrateRoot(root, entry.name, false);
    });
    if (!scan.complete) legacyScanComplete = false;
  }
  if (!blocked && legacyScanComplete) {
    try { writeFileSync(sentinel, `v${MIGRATION_VERSION}\n`, { flag: 'wx' }); } catch { /* another worker won */ }
  }
  return { blocked };
}

export function pruneMarkers(options) {
  const cfg = configOf(options);
  const maintenance = markerMaintenance(options);
  const nowMs = options.nowMs ?? Date.now();
  const capacity = acquireCapacityLeaseForPrune(cfg.markerDir, cfg, nowMs);
  if (!capacity) return false;
  const { lease: capacityLease, borrowed } = capacity;
  try {
    if (!reconcileLegacyCapacityFences(cfg.markerDir, cfg, capacityLease)) return false;
    const result = streamDirectoryEntries(cfg.markerDir, cfg.scanCap, (entry) => {
      if (!cfg.markerNameRe.test(entry.name) || !entry.isFile()) return;
      const path = join(cfg.markerDir, entry.name);
      if (path === options.protectedMarker) return;
      const inspected = inspectPath(path);
      if (inspected.status !== PRESENT || !inspected.identity?.isFile) return;
      if (!isOlderThan(inspected.identity, nowMs, cfg.ttlMs)) return;
      const claim = acquireClaim(path, nowMs, cfg);
      if (!claim) return;
      try {
        const current = inspectPath(path);
        if (current.status === PRESENT && current.identity?.isFile
            && isOlderThan(current.identity, nowMs, cfg.ttlMs)
            && markerClaimOwned(claim)) removePathIfUnchangedRecoverable(
              path, current.identity, 'marker-remove', { testInterlock: cfg.testInterlock });
      } finally { releaseMarkerClaim(claim); }
    });
    return result.complete;
  } finally { if (!borrowed) releaseLease(capacityLease); }
}

export function claimMarker(options) {
  const cfg = configOf(options);
  const maintenance = markerMaintenance(options);
  const markerDir = cfg.markerDir;
  const nowMs = options.nowMs ?? Date.now();
  const marker = options.marker || join(markerDir, `${cfg.prefix}${sessionHash(options.sessionId)}`);
  try { mkdirSync(markerDir, { recursive: true }); } catch { return null; }
  const capacityLease = acquireLease(join(markerDir, `.cah-marker-capacity-${cfg.namespace}`), {
    nowMs, ...leaseOptions(cfg, 'marker-capacity-lease-reclaim'),
  });
  if (!capacityLease) return null;
  if (!reconcileCapacityStages(markerDir, cfg, capacityLease)) {
    releaseLease(capacityLease);
    return null;
  }
  const tx = readTransaction(markerDir, { reconcileEmpty: true, recoverPublication: true,
    assertOwnership: capacityLeaseAssertion(capacityLease) });
  if (tx === null) { releaseLease(capacityLease); return null; }
  const recoveredContext = {
    capacityLease, recovered: true, maintenance, testInterlock: cfg.testInterlock,
  };
  if (tx) {
    const sessionLease = acquireLease(tx.markerClaimPath, { nowMs, ...leaseOptions(cfg, 'claim-reclaim') });
    const victimLease = acquireLease(tx.victimClaimPath, { nowMs, ...leaseOptions(cfg, 'claim-reclaim') });
    if (!sessionLease || !victimLease) {
      if (sessionLease) releaseLease(sessionLease);
      if (victimLease) releaseLease(victimLease);
      releaseLease(capacityLease);
      return null;
    }
    recoveredContext.sessionClaim = { marker: tx.marker, claimPath: tx.markerClaimPath, owner: sessionLease.owner, lease: sessionLease };
    recoveredContext.victimClaim = { marker: tx.victim, claimPath: tx.victimClaimPath, owner: victimLease.owner, lease: victimLease };
    if (!abortCapacityEviction(markerDir, tx, recoveredContext)) {
      releaseMarkerClaim(recoveredContext.sessionClaim);
      releaseMarkerClaim(recoveredContext.victimClaim);
      releaseLease(capacityLease);
      return null;
    }
    releaseMarkerClaim(recoveredContext.sessionClaim);
    releaseMarkerClaim(recoveredContext.victimClaim);
  }
  const markerState = inspectPath(marker);
  if (markerState.status === INDETERMINATE
      || (markerState.status === PRESENT && (!markerState.identity?.isFile
        || !isOlderThan(markerState.identity, nowMs, cfg.ttlMs)))) {
    releaseLease(capacityLease); return null;
  }
  const sessionClaim = acquireClaim(marker, nowMs, cfg);
  if (!sessionClaim) { releaseLease(capacityLease); return null; }
  const context = { capacityLease, sessionClaim, maintenance, testInterlock: cfg.testInterlock };
  const before = inspectPath(marker).identity;
  const prepared = prepareCapacityEviction(
    markerDir, marker, before, ownerToken(sessionClaim.owner), nowMs, cfg, context,
  );
  if (!prepared) { releaseMarkerClaim(sessionClaim); return null; }
  sessionClaim.capacityLease = capacityLease;
  sessionClaim.victimClaim = prepared.victimClaim;
  context.victimClaim = prepared.victimClaim;
  sessionClaim.capacityTransaction = prepared.state;
  sessionClaim.transactionContext = context;
  sessionClaim.maintenance = maintenance;
  return sessionClaim;
}

export function publishMarker(claim, payload, cfg) {
  if (!markerClaimOwned(claim) || !claim.capacityLease || !leaseOwned(claim.capacityLease)) return false;
  if (claim.capacityTransaction
      && !transactionLeaseValid(claim.capacityTransaction, claim.transactionContext, { requireSession: true })) return false;
  const expectedDestination = captureRegularFileSnapshot(claim.marker).expectedDestination;
  if (expectedDestination.exists && !isOlderThan(expectedDestination.identity, Date.now(), cfg.ttlMs)) return false;
  if (testOnlyFailure('CAH_TEST_ONLY_MARKER_WRITE_FAILURE')
      || testOnlyFailure('CAH_TEST_ONLY_MARKER_STATE_WRITE_FAILURE')) return false;
  try {
    if (claim.capacityTransaction
        && !persistPayloadProof(dirname(claim.marker), claim.capacityTransaction,
          claim.transactionContext, payload)) return false;
    writeFileAtomic(claim.marker, payload, {
      expectedDestination,
      testInterlock: cfg.testInterlock,
      assertOwnership: () => Boolean(markerClaimOwned(claim)
        && claim.capacityLease && leaseOwned(claim.capacityLease)
        && (!claim.capacityTransaction
          || transactionStillCurrent(dirname(claim.marker), claim.capacityTransaction,
            claim.transactionContext))),
    });
    const published = inspectPath(claim.marker);
    if (published.status !== PRESENT) return false;
    if (claim.capacityTransaction) claim.capacityTransaction.markerPublishedKey = identityKey(published.identity);
    if (process.env.CAH_TEST_ONLY === '1'
        && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-final-unlink'
          || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-final-unlink')) process.exit(95);
    return true;
  } catch { return false; }
}

export function finishMarkerTransaction(claim) {
  if (!claim?.capacityTransaction) return true;
  const result = finishCapacityEviction(
    dirname(claim.marker), claim.capacityTransaction, claim.transactionContext,
  );
  if (result) claim.capacityTransaction = null;
  return result;
}

export function abortMarkerTransaction(claim) {
  if (!claim?.capacityTransaction) return true;
  const result = abortCapacityEviction(
    dirname(claim.marker), claim.capacityTransaction, claim.transactionContext,
  );
  if (result) claim.capacityTransaction = null;
  return result;
}
