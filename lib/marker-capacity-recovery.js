import { readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLease, leaseOwned, ownerGeneration, releaseLease } from './lease-lock.js';
import { recoverPublicationFence } from './fs-atomic-publication.js';
import {
  casMoveVictim, casRemoveVictim, compareFreshness, inspectTransactionRetirement,
  payloadProof, preserveMismatch, recoverLegacyCapacityState, recoverVictimFence,
  retireTransactionState, semanticFreshness, semanticRecord, syncBestEffort,
} from './marker-capacity-ops.js';

function tokenOf(owner) {
  return owner?.nonce || owner?.token || null;
}

// Capacity recovery is kept separate from marker migration and claim policy.
// Every destructive step receives the caller's inspection and lease helpers;
// this keeps recovery generation-aware without creating a dependency cycle.
export function makeCapacityRecoveryHelpers(h) {
  const ops = () => ({
    transactionStillCurrent: (markerDir, state, context, options = {}) =>
      transactionStillCurrent(markerDir, state, context, options, h),
    inspectPath: h.inspectPath,
    identityKey: h.identityKey,
    present: h.present,
    absent: h.absent,
    indeterminate: h.indeterminate,
  });

  function transactionInspection(markerDir, {
    reconcileEmpty = false, recoverPublication = false, assertOwnership = null,
  } = {}) {
    const txPath = h.capacityTransactionPath(markerDir);
    const tx = h.inspectPath(txPath);
    if (tx.status === h.absent) return { status: h.absent, state: null };
    if (tx.status === h.indeterminate || !tx.identity?.isDirectory) {
      return { status: h.indeterminate, state: null };
    }
    let entries;
    try { entries = readdirSync(txPath); } catch {
      return { status: h.indeterminate, state: null };
    }
    if (entries.some((name) => name !== 'transaction.json' && name !== 'victim'
        && !name.startsWith('.cah-tmp-') && name !== h.publicationFenceName
        && !name.startsWith('.cah-retired-'))) {
      return { status: h.indeterminate, state: null };
    }
    let retirement = inspectTransactionRetirement(txPath, entries, {
      inspectPath: h.inspectPath,
      parseTransactionState: h.parseTransactionState,
      present: h.present,
      indeterminate: h.indeterminate,
    });
    if (retirement.status === h.indeterminate) return { status: h.indeterminate, state: null };
    let state = h.inspectPath(h.capacityStatePath(markerDir), { content: true });
    if (state.status === h.absent && retirement.reservation && reconcileEmpty
        && typeof assertOwnership === 'function') {
      try {
        const reserved = h.inspectPath(retirement.path);
        if (reserved.status === h.present && reserved.identity?.isDirectory
            && readdirSync(retirement.path).length === 0 && assertOwnership()) {
          const final = h.inspectPath(retirement.path);
          if (final.status !== h.present
              || h.identityKey(final.identity) !== h.identityKey(reserved.identity)
              || !assertOwnership()) return { status: h.indeterminate, state: null };
          rmdirSync(retirement.path);
          syncBestEffort(txPath);
          entries = readdirSync(txPath);
          retirement = inspectTransactionRetirement(txPath, entries, {
            inspectPath: h.inspectPath,
            parseTransactionState: h.parseTransactionState,
            present: h.present,
            indeterminate: h.indeterminate,
          });
        }
      } catch { return { status: h.indeterminate, state: null }; }
    }
    if (state.status === h.absent && retirement.status === h.present && retirement.state) {
      state = retirement.state;
    }
    if (state.status === h.absent) {
      const fencePath = join(dirname(h.capacityStatePath(markerDir)), h.publicationFenceName);
      const publicationFence = h.inspectPath(fencePath);
      if (publicationFence.status === h.indeterminate) {
        return { status: h.indeterminate, state: null };
      }
      if (publicationFence.status === h.present && recoverPublication) {
        try {
          const legacy = recoverLegacyCapacityState(
            markerDir, h.capacityStatePath(markerDir), fencePath, assertOwnership, {
              inspectPath: h.inspectPath,
              capacitySlotPath: h.capacitySlotPath,
              parseTransactionState: h.parseTransactionState,
              identityKey: h.identityKey,
              present: h.present,
              indeterminate: h.indeterminate,
            },
          );
          state = h.inspectPath(h.capacityStatePath(markerDir), { content: true });
          // A recognized proof that cannot re-establish its exact transaction
          // is occupied recovery state. Never parse a foreign successor.
          if (legacy.recognized && !legacy.state) {
            return { status: h.indeterminate, state: null };
          }
          if (state.status === h.absent && !legacy.recognized) {
            recoverPublicationFence(h.capacityStatePath(markerDir), { assertOwnership });
            state = h.inspectPath(h.capacityStatePath(markerDir), { content: true });
          }
        } catch { return { status: h.indeterminate, state: null }; }
      }
      const currentFence = h.inspectPath(fencePath);
      if (currentFence.status === h.indeterminate
          || (currentFence.status === h.present && state.status === h.absent)) {
        return { status: h.indeterminate, state: null };
      }
      const fenced = h.inspectPath(join(fencePath, 'old'), { content: true });
      if (fenced.status === h.present && fenced.identity?.isFile) state = fenced;
    }
    if (state.status === h.absent && reconcileEmpty) {
      try {
        if (readdirSync(txPath).length === 0
            && typeof assertOwnership === 'function' && assertOwnership()) {
          const current = h.inspectPath(txPath);
          if (current.status !== h.present || !current.identity?.isDirectory
              || h.identityKey(current.identity) !== h.identityKey(tx.identity)
              || !assertOwnership()) return { status: h.indeterminate, state: null };
          rmdirSync(txPath);
          syncBestEffort(dirname(txPath));
          return { status: h.absent, state: null };
        }
      } catch { return { status: h.indeterminate, state: null }; }
    }
    if (state.status !== h.present || !state.identity?.isFile) {
      return { status: state.status === h.absent ? h.indeterminate : state.status, state: null };
    }
    const parsed = h.parseTransactionState(state.content);
    return parsed ? { status: h.present, state: parsed }
      : { status: h.indeterminate, state: null };
  }

  function readTransaction(markerDir, options = {}) {
    const result = transactionInspection(markerDir, options);
    return result.status === h.absent ? undefined : result.status === h.present ? result.state : null;
  }

  function transactionLeaseValid(state, context, { requireSession = true } = {}) {
    if (!state || !context?.capacityLease || !leaseOwned(context.capacityLease)) return false;
    if ((!context.recovered && tokenOf(context.capacityLease.owner) !== state.capacityLeaseToken)
        || context.capacityLease.path !== state.capacityLeasePath) return false;
    if (!context.recovered && state.capacityLeaseGeneration
        && ownerGeneration(context.capacityLease.owner) !== state.capacityLeaseGeneration) return false;
    if (requireSession && (!context.sessionClaim?.lease || !leaseOwned(context.sessionClaim.lease)
        || (!context.recovered && tokenOf(context.sessionClaim.lease.owner) !== state.sessionLeaseToken)
        || context.sessionClaim.lease.path !== state.markerClaimPath)) return false;
    if (requireSession && !context.recovered && state.sessionLeaseGeneration
        && ownerGeneration(context.sessionClaim.lease.owner) !== state.sessionLeaseGeneration) return false;
    if (context.victimClaim
        && (!leaseOwned(context.victimClaim.lease)
          || (!context.recovered && tokenOf(context.victimClaim.lease.owner) !== state.victimLeaseToken)
          || context.victimClaim.lease.path !== state.victimClaimPath)) return false;
    if (context.victimClaim && !context.recovered && state.victimLeaseGeneration
        && ownerGeneration(context.victimClaim.lease.owner) !== state.victimLeaseGeneration) return false;
    return true;
  }

  function transactionStillCurrent(markerDir, state, context, options = {}) {
    if (!state?.capacityLeaseGeneration || !transactionLeaseValid(state, context, options)) return false;
    const current = transactionInspection(markerDir);
    return current.status === h.present && current.state.nonce === state.nonce
      && current.state.capacityLeaseGeneration === state.capacityLeaseGeneration
      && current.state.victimFenceGeneration === state.victimFenceGeneration;
  }

  function publicationStatus(state) {
    const marker = h.inspectPath(state.marker, { content: true });
    if (marker.status === h.indeterminate) return h.indeterminate;
    if (marker.status === h.absent || !marker.identity?.isFile) return h.absent;
    if (h.identityKey(marker.identity) === state.markerBeforeKey) return h.absent;
    if (state.expectedPayloadDigest) {
      const proof = payloadProof(marker.content);
      if (proof?.digest === state.expectedPayloadDigest
          && (!state.expectedPayloadSemantic
            || JSON.stringify(proof.semantic) === JSON.stringify(state.expectedPayloadSemantic))) return h.present;
      return h.indeterminate;
    }
    const record = semanticRecord(marker.content);
    let parsed = null;
    try { parsed = JSON.parse(marker.content.toString('utf8')); } catch { /* legacy payload */ }
    if (parsed && tokenOf(parsed) === state.nonce) return h.present;
    if (state.markerBeforeKey === 'absent' && record.time === null) return h.present;
    return state.markerPublishedKey && h.identityKey(marker.identity) === state.markerPublishedKey
      ? h.present : h.indeterminate;
  }

  function cleanupTransaction(markerDir, state, context) {
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    try {
      if (!transactionStillCurrent(markerDir, state, context)) return false;
      if (!finishStatePublication(markerDir, state, context)) return false;
      if (!recoverVictimFences(markerDir, state, context)) return false;
      const remainingSlot = h.inspectPath(h.capacitySlotPath(markerDir));
      if (remainingSlot.status !== h.absent) return false;
      const txDir = h.capacityTransactionPath(markerDir);
      const entries = readdirSync(txDir);
      if (entries.some((name) => name !== 'transaction.json' && name !== 'victim'
          && !name.startsWith('.cah-tmp-') && name !== h.publicationFenceName
          && !name.startsWith('.cah-retired-'))) return false;
      if (!retireTransactionState(markerDir, state, context, {
        capacityTransactionPath: h.capacityTransactionPath,
        capacityStatePath: h.capacityStatePath,
        inspectPath: h.inspectPath,
        parseTransactionState: h.parseTransactionState,
        transactionInspection,
        transactionLeaseValid,
        transactionStillCurrent,
        present: h.present,
        indeterminate: h.indeterminate,
      })) return false;
      const dir = h.inspectPath(txDir);
      if (dir.status === h.indeterminate) return false;
      if (dir.status === h.present && readdirSync(txDir).length === 0) {
        const finalDir = h.inspectPath(txDir);
        if (finalDir.status !== h.present || !finalDir.identity?.isDirectory
            || h.identityKey(finalDir.identity) !== h.identityKey(dir.identity)
            || !transactionLeaseValid(state, context)) return false;
        rmdirSync(txDir);
        syncBestEffort(dirname(txDir));
      }
      return true;
    } catch { return false; }
  }

  function recoverVictimFences(markerDir, state, context) {
    for (const sourcePath of [state.victim, h.capacitySlotPath(markerDir)]) {
      if (!recoverVictimFence(markerDir, state, context, sourcePath, ops())) return false;
    }
    return true;
  }

  function restoreVictim(markerDir, state, context) {
    if (!recoverVictimFences(markerDir, state, context)) return false;
    const slot = h.inspectPath(h.capacitySlotPath(markerDir));
    const canonical = h.inspectPath(state.victim, { content: true });
    if (slot.status === h.indeterminate || canonical.status === h.indeterminate) return false;
    if (slot.status === h.absent) return canonical.status === h.present;
    if (canonical.status === h.absent) {
      return casMoveVictim(markerDir, state, context, h.capacitySlotPath(markerDir), state.victim,
        null, ops());
    }
    const victimFresh = semanticFreshness(state.victim, slot);
    const successorFresh = semanticFreshness(state.victim, canonical);
    if (compareFreshness(successorFresh, victimFresh) === null
        || compareFreshness(successorFresh, victimFresh) < 0) return false;
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    const currentCanonical = h.inspectPath(state.victim);
    if (currentCanonical.status !== h.present
        || h.identityKey(currentCanonical.identity) !== h.identityKey(canonical.identity)) {
      preserveMismatch(context, state.victim, h.identityKey(canonical.identity),
        currentCanonical.status === h.present ? h.identityKey(currentCanonical.identity) : currentCanonical.status);
      return false;
    }
    return casRemoveVictim(markerDir, state, context, h.capacitySlotPath(markerDir), ops());
  }

  function finishStatePublication(markerDir, state, context) {
    const statePath = h.capacityStatePath(markerDir);
    const fencePath = join(dirname(statePath), h.publicationFenceName);
    const fence = h.inspectPath(fencePath);
    if (fence.status === h.indeterminate) return false;
    if (fence.status === h.absent) return true;
    try {
      const recovered = recoverPublicationFence(statePath, {
        assertOwnership: () => {
          if (!transactionStillCurrent(markerDir, state, context)) {
            throw new Error('capacity transaction changed during publication recovery');
          }
        },
      });
      return recovered && h.inspectPath(fencePath).status === h.absent;
    } catch { return false; }
  }

  function finishCapacityEviction(markerDir, state, context) {
    if (!state || !transactionStillCurrent(markerDir, state, context)) return false;
    const publication = publicationStatus(state);
    if (publication === h.indeterminate || publication !== h.present) return false;
    try {
      if (!recoverVictimFences(markerDir, state, context)) return false;
      const slot = h.inspectPath(h.capacitySlotPath(markerDir));
      if (slot.status === h.indeterminate) return false;
      if (slot.status === h.absent) {
        const victim = h.inspectPath(state.victim);
        if (victim.status === h.indeterminate) return false;
        if (victim.status === h.present
            && !casMoveVictim(markerDir, state, context, state.victim,
              h.capacitySlotPath(markerDir), null, ops())) return false;
      }
      if (h.testOnlyFailure('CAH_TEST_ONLY_FINAL_UNLINK_FAILURE')
          || h.testOnlyFailure('CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE')
          || h.testOnlyFailure('CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE')) return false;
      const finalSlot = h.inspectPath(h.capacitySlotPath(markerDir));
      if (finalSlot.status === h.indeterminate) return false;
      if (finalSlot.status === h.present
          && !casRemoveVictim(markerDir, state, context, h.capacitySlotPath(markerDir), ops())) return false;
      return cleanupTransaction(markerDir, state, context);
    } catch { return false; }
  }

  function abortCapacityEviction(markerDir, state, context) {
    if (!state) return true;
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    const publication = publicationStatus(state);
    if (publication === h.indeterminate) return false;
    if (publication === h.present) return finishCapacityEviction(markerDir, state, context);
    if (!restoreVictim(markerDir, state, context)) return false;
    return cleanupTransaction(markerDir, state, context);
  }

  function recoverCapacityTransaction(markerDir, state, capacityLease, nowMs, cfg, maintenance = null) {
    const sessionLease = acquireLease(state.markerClaimPath, {
      nowMs, ...h.leaseOptions(cfg, 'claim-reclaim'),
    });
    const victimLease = acquireLease(state.victimClaimPath, {
      nowMs, ...h.leaseOptions(cfg, 'claim-reclaim'),
    });
    if (!sessionLease || !victimLease) {
      if (sessionLease) releaseLease(sessionLease);
      if (victimLease) releaseLease(victimLease);
      return false;
    }
    const context = {
      capacityLease, recovered: true, maintenance, testInterlock: cfg.testInterlock,
      sessionClaim: { marker: state.marker, claimPath: state.markerClaimPath,
        owner: sessionLease.owner, lease: sessionLease },
      victimClaim: { marker: state.victim, claimPath: state.victimClaimPath,
        owner: victimLease.owner, lease: victimLease },
    };
    try { return abortCapacityEviction(markerDir, state, context); }
    finally {
      h.releaseMarkerClaim(context.sessionClaim);
      h.releaseMarkerClaim(context.victimClaim);
    }
  }

  return {
    transactionInspection,
    readTransaction,
    transactionLeaseValid,
    transactionStillCurrent,
    cleanupTransaction,
    capacityOps: ops,
    restoreVictim,
    finishCapacityEviction,
    abortCapacityEviction,
    recoverCapacityTransaction,
  };
}
