import { rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  acquireLease, leaseOwned, ownerGeneration, releaseLease, streamDirectoryEntriesLookahead,
} from './lease-lock.js';
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
    transactionStillCurrent,
    inspectPath: h.inspectPath,
    identityKey: h.identityKey,
    present: h.present,
    absent: h.absent,
    indeterminate: h.indeterminate,
  });

  function transactionInspection(markerDir, {
    reconcileEmpty = false, recoverPublication = false, assertOwnership = null,
    expectedGeneration = null, retirementLimit = 16, lifecycleLeases = null,
    preflight = false, config = null, maintenance = null, inspectRetirements = true,
  } = {}) {
    const txPath = h.capacityTransactionPath(markerDir);
    const tx = h.inspectPath(txPath);
    if (tx.status === h.absent) return { status: h.absent, state: null };
    if (tx.status === h.indeterminate || !tx.identity?.isDirectory) {
      return { status: h.indeterminate, state: null };
    }
    const entries = [];
    const entryScan = streamDirectoryEntriesLookahead(txPath,
      Math.max(8, (Number.isSafeInteger(retirementLimit) ? retirementLimit : 16) + 4),
      (entry) => entries.push(entry.name));
    if (!entryScan.complete && !entryScan.truncated) {
      return { status: h.indeterminate, state: null };
    }
    if (entryScan.truncated && maintenance) {
      maintenance.incomplete = true;
      maintenance.truncated = true;
    }
    if (entries.some((name) => name !== 'transaction.json' && name !== 'victim'
        && !name.startsWith('.cah-tmp-') && name !== h.publicationFenceName
        && !name.startsWith('.cah-retired-'))) {
      return { status: h.indeterminate, state: null };
    }
    let retirement = inspectRetirements
      ? inspectTransactionRetirement(txPath, entries, {
        inspectPath: h.inspectPath,
        parseTransactionState: h.parseTransactionState,
        present: h.present,
        indeterminate: h.indeterminate,
        validateState: (candidate) => stateBelongsToMarkerDir(candidate, markerDir, config),
        limit: retirementLimit, truncated: entryScan.truncated,
      })
      : { status: h.absent, reservations: [], truncated: entryScan.truncated };
    if (retirement.status === h.indeterminate) {
      return { status: h.indeterminate, state: null };
    }
    let state = h.inspectPath(h.capacityStatePath(markerDir), { content: true });
    if (state.status === h.present) {
      const parsed = state.identity?.isFile ? h.parseTransactionState(state.content) : null;
      if (!parsed || !stateBelongsToMarkerDir(parsed, markerDir, config)) {
        return { status: h.indeterminate, state: null };
      }
    } else if (state.status === h.indeterminate) {
      return { status: h.indeterminate, state: null };
    }
    if (reconcileEmpty && retirement.reservations?.length
        && typeof assertOwnership === 'function') {
      try {
        for (const reservation of retirement.reservations) {
          const reserved = h.inspectPath(reservation.path);
          if (reserved.status === h.absent) continue;
          if (reserved.status !== h.present || !reserved.identity?.isDirectory
              || h.identityKey(reserved.identity) !== h.identityKey(reservation.identity)
              || !directoryIsEmpty(reservation.path) || !assertOwnership()) {
            return { status: h.indeterminate, state: null };
          }
          const final = h.inspectPath(reservation.path);
          if (final.status !== h.present
              || h.identityKey(final.identity) !== h.identityKey(reserved.identity)
              || !assertOwnership()) return { status: h.indeterminate, state: null };
          rmdirSync(reservation.path);
          syncBestEffort(txPath);
        }
        entries.length = 0;
        const afterReservationScan = streamDirectoryEntriesLookahead(txPath,
          Math.max(8, retirementLimit + 4), (entry) => entries.push(entry.name));
        if (!afterReservationScan.complete && !afterReservationScan.truncated) {
          return { status: h.indeterminate, state: null };
        }
        if (afterReservationScan.truncated && maintenance) {
          maintenance.incomplete = true;
          maintenance.truncated = true;
        }
        retirement = inspectTransactionRetirement(txPath, entries, {
          inspectPath: h.inspectPath,
          parseTransactionState: h.parseTransactionState,
          present: h.present,
          indeterminate: h.indeterminate,
          validateState: (candidate) => stateBelongsToMarkerDir(candidate, markerDir, config),
          limit: retirementLimit, truncated: afterReservationScan.truncated,
        });
        if (retirement.status === h.indeterminate) return { status: h.indeterminate, state: null };
      } catch { return { status: h.indeterminate, state: null }; }
    }

    // A successor can publish a new canonical transaction while an older
    // owner is paused between linking its state into a private retirement
    // directory and unlinking the canonical name. Once the current capacity
    // lease is verified and canonical state is valid, discard only retirement
    // links proven stale. The canonical entry is never part of this cleanup set.
    if (reconcileEmpty && retirement.records?.length && state.status === h.present
        && state.identity?.isFile && typeof assertOwnership === 'function') {
      const canonical = h.parseTransactionState(state.content);
      if (!canonical || !stateBelongsToMarkerDir(canonical, markerDir, config)) {
        return { status: h.indeterminate, state: null };
      }
      // A canonical transaction from the expired owner is still recoverable;
      // only a generation that matches the lease just acquired can authorize
      // retirement-record cleanup during this inspection.
      if (expectedGeneration && assertOwnership()) {
        const reconciliation = reconcileExpiredRetirements(markerDir,
          h.capacityStatePath(markerDir), state, canonical, retirement.records,
           expectedGeneration, assertOwnership, retirementLimit, config);
        if (!reconciliation.ok) {
          return { status: h.indeterminate, state: null };
        }
        entries.length = 0;
        const afterRetirementScan = streamDirectoryEntriesLookahead(txPath,
          Math.max(8, retirementLimit + 4), (entry) => entries.push(entry.name));
        if (!afterRetirementScan.complete && !afterRetirementScan.truncated) {
          return { status: h.indeterminate, state: null };
        }
        if (afterRetirementScan.truncated && maintenance) {
          maintenance.incomplete = true;
          maintenance.truncated = true;
        }
        retirement = inspectTransactionRetirement(txPath, entries, {
          inspectPath: h.inspectPath,
          parseTransactionState: h.parseTransactionState,
          present: h.present,
          indeterminate: h.indeterminate,
          validateState: (candidate) => stateBelongsToMarkerDir(candidate, markerDir, config),
          limit: retirementLimit, truncated: afterRetirementScan.truncated,
        });
        if (retirement.status === h.indeterminate) return { status: h.indeterminate, state: null };
      }
    }
    if (state.status === h.absent && retirement.status === h.present
        && !retirement.truncated && retirement.records?.length === 1) {
      state = { status: h.present, identity: retirement.records[0].retiredIdentity,
        content: Buffer.from(JSON.stringify(retirement.records[0].state)) };
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
              validateState: (candidate) => stateBelongsToMarkerDir(candidate, markerDir, config),
            },
          );
          state = h.inspectPath(h.capacityStatePath(markerDir), { content: true });
          // A recognized proof that cannot re-establish its exact transaction
          // is occupied recovery state. Never parse a foreign successor.
          if (legacy.recognized && !legacy.state) {
            return { status: h.indeterminate, state: null };
          }
          if (state.status === h.absent && !legacy.recognized) {
            recoverPublicationFence(h.capacityStatePath(markerDir), {
              lifecycleLeases, assertOwnership,
            });
            state = h.inspectPath(h.capacityStatePath(markerDir), { content: true });
          }
        } catch { return { status: h.indeterminate, state: null }; }
      }
      const currentFence = h.inspectPath(fencePath);
      if (currentFence.status === h.indeterminate
          || (currentFence.status === h.present && state.status === h.absent)) {
        if (preflight && currentFence.status === h.present && state.status === h.absent) {
          return { status: h.absent, state: null };
        }
        return { status: h.indeterminate, state: null };
      }
      const fenced = h.inspectPath(join(fencePath, 'old'), { content: true });
      if (fenced.status === h.present && fenced.identity?.isFile) state = fenced;
    }
    if (state.status === h.absent && reconcileEmpty) {
      try {
        const emptyEntries = [];
        const emptyScan = streamDirectoryEntriesLookahead(txPath, 1,
          (entry) => emptyEntries.push(entry.name));
        if (emptyScan.complete && emptyEntries.length === 0
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
      if (preflight && state.status === h.absent) return { status: h.absent, state: null };
      return { status: state.status === h.absent ? h.indeterminate : state.status, state: null };
    }
    const parsed = h.parseTransactionState(state.content);
    return parsed && stateBelongsToMarkerDir(parsed, markerDir, config)
      ? { status: h.present, state: parsed, retirement }
      : { status: h.indeterminate, state: null };
  }

  function directoryIsEmpty(path) {
    const entries = [];
    const scan = streamDirectoryEntriesLookahead(path, 1,
      (entry) => entries.push(entry.name));
    return scan.complete && entries.length === 0;
  }

  function stableIdentity(identity) {
    if (!identity) return null;
    return [identity.dev, identity.ino, identity.mode, identity.isFile,
      identity.isDirectory, identity.isSymbolicLink].map((value) => String(value)).join(':');
  }

  function stableFileIdentity(identity) {
    if (!identity) return null;
    return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeNs,
      identity.contentDigest, identity.isFile, identity.isDirectory,
      identity.isSymbolicLink].map((value) => String(value)).join(':');
  }

  function stateBelongsToMarkerDir(state, markerDir, config = null) {
    const root = resolve(markerDir);
    const inRoot = (path) => typeof path === 'string' && resolve(dirname(path)) === root;
    return h.validateStatePaths ? h.validateStatePaths(markerDir, state, config)
      : inRoot(state.marker) && inRoot(state.victim) && inRoot(state.capacityLeasePath)
      && inRoot(state.markerClaimPath) && inRoot(state.victimClaimPath)
      && resolve(state.markerClaimPath) === resolve(join(markerDir, `.cah-marker-claim-${basename(state.marker)}`))
      && resolve(state.victimClaimPath) === resolve(join(markerDir, `.cah-marker-claim-${basename(state.victim)}`))
      && basename(state.markerClaimPath).startsWith('.cah-marker-claim-')
      && basename(state.victimClaimPath).startsWith('.cah-marker-claim-')
      && basename(state.capacityLeasePath).startsWith('.cah-marker-capacity-');
  }

  function canonicalStillCurrent(markerDir, txPath, expected, expectedIdentity, assertOwnership,
    config = null) {
    if (!assertOwnership()) return false;
    const current = h.inspectPath(txPath, { content: true });
    const parsed = current.status === h.present ? h.parseTransactionState(current.content) : null;
    const result = current.status === h.present && current.identity?.isFile
      && stableFileIdentity(current.identity) === stableFileIdentity(expectedIdentity)
      && stateBelongsToMarkerDir(parsed, markerDir, config)
      && parsed?.capacityLeaseGeneration === expected.capacityLeaseGeneration
      && parsed?.nonce === expected.nonce
      && assertOwnership();
    return result;
  }

  function reconcileExpiredRetirements(markerDir, txPath, canonicalInspection, canonical,
    records, expectedGeneration, assertOwnership, limit = 16, config = null) {
    const canonicalKey = canonicalInspection.identity;
    let blocked = false;
    let processed = 0;
    const ordered = [...records].sort((left, right) => left.path.localeCompare(right.path));
    for (const record of ordered) {
      const sameCanonicalLink = record.state.capacityLeaseGeneration
        === canonical.capacityLeaseGeneration
        && h.identityKey(record.retiredIdentity) === h.identityKey(canonicalInspection.identity)
        && Buffer.isBuffer(canonicalInspection.content)
        && record.content.equals(canonicalInspection.content);
      // Keep a live successor or an unrelated generation visible. An exact
      // hard link to the canonical state is the only same-generation record
      // that can be retired without losing evidence.
      if ((record.state.capacityLeaseGeneration === canonical.capacityLeaseGeneration
        || record.state.capacityLeaseGeneration === expectedGeneration) && !sameCanonicalLink) {
        blocked = true;
        continue;
      }
      if (processed >= Math.max(1, Number.isSafeInteger(limit) ? limit : 16)) break;
      if (!stateBelongsToMarkerDir(record.state, markerDir, config)
          || record.state.capacityLeasePath !== canonical.capacityLeasePath) {
        blocked = true;
        continue;
      }
      const root = h.inspectPath(record.path);
      const child = h.inspectPath(record.retiredPath, { content: true });
      const entries = [];
      const entryScan = streamDirectoryEntriesLookahead(record.path, 1,
        (entry) => entries.push(entry.name));
      const childState = child.status === h.present ? h.parseTransactionState(child.content) : null;
      if (root.status !== h.present || !root.identity?.isDirectory
          || stableIdentity(root.identity) !== stableIdentity(record.identity)
          || child.status !== h.present || !child.identity?.isFile
          || h.identityKey(child.identity) !== h.identityKey(record.retiredIdentity)
          || !Buffer.isBuffer(child.content) || !child.content.equals(record.content)
          || !entryScan.complete || entries.length !== 1 || entries[0] !== 'transaction.json'
           || !childState
           || childState.capacityLeaseGeneration
            !== record.state.capacityLeaseGeneration) return { ok: false };
      if (!canonicalStillCurrent(markerDir, txPath, canonical, canonicalKey, assertOwnership,
        config)) return { ok: false };
      const finalChild = h.inspectPath(record.retiredPath, { content: true });
      if (finalChild.status !== h.present || !finalChild.identity?.isFile
          || h.identityKey(finalChild.identity) !== h.identityKey(record.retiredIdentity)
          || !Buffer.isBuffer(finalChild.content) || !finalChild.content.equals(record.content)
          || !canonicalStillCurrent(markerDir, txPath, canonical, canonicalKey, assertOwnership,
            config)) return { ok: false };
      try {
        unlinkSync(record.retiredPath);
        syncBestEffort(record.path);
      } catch { return { ok: false }; }
      const afterChild = h.inspectPath(record.path);
      const afterEntries = [];
      const afterEntryScan = streamDirectoryEntriesLookahead(record.path, 1,
        (entry) => afterEntries.push(entry.name));
      if (afterChild.status !== h.present || !afterChild.identity?.isDirectory
          || stableIdentity(afterChild.identity) !== stableIdentity(record.identity)
          || !afterEntryScan.complete || afterEntries.length !== 0
          || !canonicalStillCurrent(markerDir, txPath, canonical, canonicalKey, assertOwnership,
            config)) return { ok: false };
      const finalRoot = h.inspectPath(record.path);
      const finalEntries = [];
      const finalEntryScan = streamDirectoryEntriesLookahead(record.path, 1,
        (entry) => finalEntries.push(entry.name));
      if (finalRoot.status !== h.present || !finalRoot.identity?.isDirectory
          || stableIdentity(finalRoot.identity) !== stableIdentity(record.identity)
          || !finalEntryScan.complete || finalEntries.length !== 0
          || !canonicalStillCurrent(markerDir, txPath, canonical, canonicalKey, assertOwnership,
            config)) return { ok: false };
      try {
        rmdirSync(record.path);
        syncBestEffort(txPath);
      } catch { return { ok: false }; }
      processed += 1;
    }
    return { ok: !blocked };
  }

  function readTransaction(markerDir, options = {}) {
    const result = transactionInspection(markerDir, options);
    return result.status === h.absent ? undefined : result.status === h.present ? result.state : null;
  }

  function transactionLeaseValid(state, context, { requireSession = true } = {}) {
    if (!state || !context?.capacityLease || !leaseOwned(context.capacityLease)) return false;
    if (!stateBelongsToMarkerDir(state, dirname(context.capacityLease.path), context.config)) return false;
    if ((!context.recovered && tokenOf(context.capacityLease.owner) !== state.capacityLeaseToken)
        || context.capacityLease.path !== state.capacityLeasePath) return false;
    if (!context.recovered && state.capacityLeaseGeneration
        && ownerGeneration(context.capacityLease.owner) !== state.capacityLeaseGeneration) return false;
    if (requireSession && (!context.sessionClaim?.lease || !leaseOwned(context.sessionClaim.lease)
        || (!context.recovered && tokenOf(context.sessionClaim.lease.owner) !== state.sessionLeaseToken)
        || (!context.recovered && tokenOf(context.sessionClaim.lease.owner) !== state.markerClaimToken)
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

  function transactionStillCurrent(markerDir, state, context) {
    if (!state?.capacityLeaseGeneration || !transactionLeaseValid(state, context)) return false;
    const canonical = h.inspectPath(h.capacityStatePath(markerDir));
    const current = canonical.status === h.absent
      ? transactionInspection(markerDir, {
        config: context?.config, retirementLimit: 1,
      })
      : transactionInspection(markerDir, {
        config: context?.config, inspectRetirements: false,
      });
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
      const currentInspection = transactionInspection(markerDir, { config: context?.config });
      if (currentInspection.status !== h.present || !currentInspection.state
          || currentInspection.state.nonce !== state.nonce
          || (h.inspectPath(h.capacityStatePath(markerDir)).status === h.present
            && (currentInspection.retirement?.records?.length
              || currentInspection.retirement?.truncated))) return false;
      if (!finishStatePublication(markerDir, state, context)) return false;
      if (!recoverVictimFences(markerDir, state, context)) return false;
      const remainingSlot = h.inspectPath(h.capacitySlotPath(markerDir));
      if (remainingSlot.status !== h.absent) return false;
      if (!resolveTransactionTemps(markerDir, state, context)) return false;
      const txDir = h.capacityTransactionPath(markerDir);
      const entries = [];
      const entryScan = streamDirectoryEntriesLookahead(txDir, 32,
        (entry) => entries.push(entry.name));
      if (!entryScan.complete) return false;
      if (entries.some((name) => name !== 'transaction.json' && name !== 'victim'
          && name !== h.publicationFenceName && !name.startsWith('.cah-retired-'))) return false;
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
      if (dir.status === h.present && directoryIsEmpty(txDir)) {
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

  function transactionTempMatches(tempState, state) {
    if (!tempState || !state) return false;
    const keys = [
      'version', 'marker', 'victim', 'victimKey', 'markerBeforeKey', 'nonce',
      'markerClaimPath', 'markerClaimToken', 'sessionLeaseToken',
      'victimClaimPath', 'victimLeaseToken', 'capacityLeasePath',
      'capacityLeaseToken', 'capacityLeaseGeneration', 'victimFenceGeneration',
      'sessionLeaseGeneration', 'victimLeaseGeneration',
    ];
    return keys.every((key) => tempState[key] === state[key]);
  }

  function resolveTransactionTemps(markerDir, state, context) {
    const txDir = h.capacityTransactionPath(markerDir);
    const entries = [];
    const entryScan = streamDirectoryEntriesLookahead(txDir, 32,
      (entry) => entries.push(entry.name));
    if (!entryScan.complete) return false;
    const tempNames = entries.filter((name) => name.startsWith('.cah-tmp-'));
    for (const name of tempNames) {
      const path = join(txDir, name);
      const observed = h.inspectPath(path, { content: true });
      const parsed = observed.status === h.present && observed.identity?.isFile
        ? h.parseTransactionState(observed.content) : null;
      if (!parsed && observed.status === h.present && observed.identity?.isFile) {
        // A crash can leave an empty or partially-written pre-proof temp that
        // cannot carry transaction metadata.  The current canonical state and
        // capacity generation are the ownership proof; remove only the exact
        // inode observed under that private transaction directory.
        const observedKey = h.identityKey(observed.identity);
        if (!transactionStillCurrent(markerDir, state, context)) return false;
        const current = h.inspectPath(path);
        if (current.status !== h.present || !current.identity?.isFile
            || h.identityKey(current.identity) !== observedKey
            || !transactionStillCurrent(markerDir, state, context)) {
          preserveMismatch(context, path, state.nonce,
            current.status === h.present ? h.identityKey(current.identity) : current.status);
          return false;
        }
        try {
          unlinkSync(path);
          syncBestEffort(txDir);
        } catch { return false; }
        continue;
      }
      if (!transactionTempMatches(parsed, state)) {
        preserveMismatch(context, path, state.nonce, observed.status === h.present
          ? h.identityKey(observed.identity) : observed.status);
        return false;
      }
      const observedKey = h.identityKey(observed.identity);
      if (!transactionStillCurrent(markerDir, state, context)) return false;
      const current = h.inspectPath(path, { content: true });
      if (current.status !== h.present || !current.identity?.isFile
          || h.identityKey(current.identity) !== observedKey
          || !current.content.equals(observed.content)
          || !transactionTempMatches(h.parseTransactionState(current.content), state)
          || !transactionStillCurrent(markerDir, state, context)) {
        preserveMismatch(context, path, state.nonce, current.status === h.present
          ? h.identityKey(current.identity) : current.status);
        return false;
      }
      try {
        unlinkSync(path);
        syncBestEffort(txDir);
      } catch { return false; }
    }
    return true;
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
        lifecycleLeases: [context?.capacityLease, context?.sessionClaim?.lease,
          context?.victimClaim?.lease].filter(Boolean),
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
    if (publication !== h.present) return false;
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
    if (!stateBelongsToMarkerDir(state, markerDir, cfg)
        || resolve(state.capacityLeasePath)
          !== resolve(join(markerDir, `.cah-marker-capacity-${cfg.namespace}`))) return false;
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
      capacityLease, recovered: true, config: cfg, maintenance, testInterlock: cfg.testInterlock,
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
