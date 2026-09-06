import { linkSync, unlinkSync, openSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { captureRegularFileSnapshot } from './fsutil.js';
import { readPublicationProof, syncDirectory } from './fs-atomic-publication.js';

function ownerToken(owner) { return owner?.nonce || owner?.token || null; }

export function semanticRecord(data) {
  if (!data) return { time: null, delivered: false, pending: false };
  let value = null;
  try { value = JSON.parse(data.toString('utf8')); } catch { /* legacy marker bytes */ }
  const timeKeys = ['deliveredAt', 'lastStampedAt', 'timestamp', 'claimedAt', 'startedAt', 'ts'];
  let time = null;
  for (const key of timeKeys) {
    if (Number.isFinite(value?.[key])) { time = value[key]; break; }
  }
  return {
    time,
    delivered: value?.deliveryState !== 'pending' && (value?.deliveredAt !== undefined
      || value?.deliveryState === 'delivered' || value?.nonce !== undefined),
    pending: value?.deliveryState === 'pending',
  };
}

export function semanticFreshness(path, inspected) {
  if (inspected.status !== 'present') return null;
  const record = semanticRecord(inspected.content);
  const mtime = inspected.identity?.mtimeNs;
  return {
    delivered: record.delivered ? 1 : 0,
    time: record.time === null ? -1 : record.time,
    mtime: typeof mtime === 'bigint' ? mtime : Number.isFinite(mtime) ? mtime : -1,
    path,
  };
}

export function compareFreshness(left, right) {
  if (!left || !right) return null;
  for (const key of ['delivered', 'time', 'mtime']) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (key === 'mtime' && typeof leftValue === 'bigint' && typeof rightValue === 'bigint') {
      if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
    } else if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

export function sourceWins(source, target) {
  const left = semanticFreshness(source.path, source);
  const right = semanticFreshness(target.path, target);
  const result = compareFreshness(left, right);
  return result === null ? null : result > 0;
}

export function payloadProof(payload) {
  if (payload === null || payload === undefined) return null;
  const content = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const parsed = (() => { try { return JSON.parse(content.toString('utf8')); } catch { return null; } })();
  const semantic = semanticRecord(content);
  return { digest: createHash('sha256').update(content).digest('hex'),
    semantic: { delivered: semantic.delivered, pending: semantic.pending, time: semantic.time,
      nonce: ownerToken(parsed) } };
}

export function victimIdentityKey(identity) {
  if (!identity) return null;
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeNs,
    identity.contentDigest, identity.isFile, identity.isDirectory,
    identity.isSymbolicLink].map((value) => String(value)).join(':');
}

export function victimKeyMatches(identity, state, identityKey) {
  return identityKey(identity) === state.victimKey
    || (state.victimStableKey && victimIdentityKey(identity) === state.victimStableKey);
}

export function addMaintenancePath(maintenance, field, path) {
  if (!maintenance || !path) return;
  if (!Array.isArray(maintenance[field])) maintenance[field] = [];
  if (!maintenance[field].includes(path)) maintenance[field].push(path);
}

export function markerMaintenance(options = {}) {
  const maintenance = options.maintenance || {};
  for (const field of ['preserved', 'recovery', 'failures']) {
    if (!Array.isArray(maintenance[field])) maintenance[field] = [];
  }
  maintenance.incomplete = Boolean(maintenance.incomplete);
  maintenance.truncated = Boolean(maintenance.truncated);
  return maintenance;
}

export function preserveMismatch(context, path, expected, actual) {
  if (!context) return;
  context.victimMismatch = { path, expected, actual };
  addMaintenancePath(context.maintenance, 'preserved', path);
  addMaintenancePath(context.maintenance, 'recovery', path);
}

export function syncBestEffort(path) { return syncDirectory(path) !== false; }

export function syncMoveParents(sourcePath, destinationPath) {
  syncBestEffort(dirname(sourcePath));
  syncBestEffort(dirname(destinationPath));
}

export function durableJson(path, value) {
  let fd = null;
  try {
    fd = openSync(path, 'wx', 0o600);
    const data = Buffer.from(`${JSON.stringify(value)}\n`);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function proofIdentityMatches(identity, encoded) {
  if (!identity || !encoded) return false;
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs']
    .every((key) => String(identity[key]) === String(encoded[key]));
}

export function recoverLegacyCapacityState(markerDir, statePath, fencePath, assertOwnership,
  { inspectPath, capacitySlotPath, parseTransactionState, identityKey, present, indeterminate } = {}) {
  const proof = readPublicationProof(fencePath);
  if (!proof) return { recognized: false, state: null };
  if (resolve(proof.destination) !== resolve(statePath)
      || resolve(proof.fencePath) !== resolve(fencePath)
      || resolve(dirname(proof.tempPath)) !== resolve(dirname(statePath))
      || !basename(proof.tempPath).startsWith('.cah-tmp-')) {
    return { recognized: true, state: null };
  }
  const temp = inspectPath(proof.tempPath, { content: true });
  if (temp.status !== present || !temp.identity?.isFile
      || !proofIdentityMatches(temp.identity, proof.tempIdentity)) {
    return { recognized: true, state: null };
  }
  const snapshot = captureRegularFileSnapshot(proof.tempPath);
  if (!snapshot.present
      || (proof.tempBytes !== null && snapshot.contentBytes !== proof.tempBytes)
      || (proof.tempDigest !== null && snapshot.contentDigest !== proof.tempDigest)) {
    return { recognized: true, state: null };
  }
  const parsed = parseTransactionState(temp.content);
  if (!parsed || resolve(dirname(parsed.marker)) !== resolve(markerDir)
      || resolve(dirname(parsed.victim)) !== resolve(markerDir)
      || resolve(dirname(parsed.capacityLeasePath)) !== resolve(markerDir)
      || !basename(parsed.capacityLeasePath).startsWith('.cah-marker-capacity-')) {
    return { recognized: true, state: null };
  }
  const retainedSlot = inspectPath(capacitySlotPath(markerDir));
  if (retainedSlot.status !== present || !retainedSlot.identity?.isFile
      || !victimKeyMatches(retainedSlot.identity, parsed, identityKey)) {
    return { recognized: true, state: null };
  }
  if (proof.leaseGeneration && parsed.capacityLeaseGeneration
      && proof.leaseGeneration !== parsed.capacityLeaseGeneration) {
    return { recognized: true, state: null };
  }
  if (assertOwnership) assertOwnership();
  const current = inspectPath(statePath);
  if (current.status === indeterminate) return { recognized: true, state: null };
  let linkedState = false;
  if (current.status === 'absent') {
    try {
      linkSync(proof.tempPath, statePath);
      linkedState = true;
      syncMoveParents(proof.tempPath, statePath);
    } catch (error) {
      if (error?.code !== 'EEXIST') return { recognized: true, state: null };
    }
  }
  const restored = inspectPath(statePath, { content: true });
  if (restored.status !== present || !restored.identity?.isFile) {
    return { recognized: true, state: null };
  }
  if (!proofIdentityMatches(restored.identity, proof.tempIdentity)) {
    // A concurrent successor may have won the absent-state slot. Never parse
    // or operate on that successor as transaction state. If this invocation
    // created a link to a changed temp entry, remove only that exact link.
    if (linkedState) {
      const currentState = inspectPath(statePath);
      if (proofIdentityMatches(currentState.identity, restored.identity)) {
        try { unlinkSync(statePath); syncBestEffort(dirname(statePath)); } catch { /* preserve */ }
      }
    }
    return { recognized: true, state: null };
  }
  const restoredState = parseTransactionState(restored.content);
  if (!restoredState) return { recognized: true, state: null };
  const tempAfter = inspectPath(proof.tempPath);
  if (tempAfter.status === present && proofIdentityMatches(tempAfter.identity, proof.tempIdentity)) {
    try {
      unlinkSync(proof.tempPath);
      syncMoveParents(proof.tempPath, statePath);
    } catch { return { recognized: true, state: null }; }
  }
  return { recognized: true, state: restoredState };
}

export function mutateVictimSlot(markerDir, state, context, sourcePath, destinationPath,
  destinationKey, mutation, { interlock = true, transactionStillCurrent, inspectPath,
    identityKey, present, absent } = {}) {
  if (interlock) context?.testInterlock?.('marker-capacity-slot', 'before', 'marker-capacity');
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const source = inspectPath(sourcePath, { content: true });
  if (source.status !== present || !source.identity?.isFile || !victimKeyMatches(source.identity, state, identityKey)) {
    preserveMismatch(context, sourcePath, state.victimKey,
      source.status === present ? identityKey(source.identity) : source.status);
    return false;
  }
  if (destinationKey !== undefined) {
    const destination = sourcePath === destinationPath
      ? source : inspectPath(destinationPath, { content: true });
    const matches = destinationKey === null
      ? destination.status === absent
      : destination.status === present && identityKey(destination.identity) === destinationKey;
    if (!matches) {
      preserveMismatch(context, destinationPath, destinationKey,
        destination.status === present ? identityKey(destination.identity) : destination.status);
      return false;
    }
  }
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const finalSource = inspectPath(sourcePath);
  if (finalSource.status !== present || !finalSource.identity?.isFile
      || !victimKeyMatches(finalSource.identity, state, identityKey)) {
    preserveMismatch(context, sourcePath, state.victimKey,
      finalSource.status === present ? identityKey(finalSource.identity) : finalSource.status);
    return false;
  }
  try {
    mutation();
  } catch {
    // A no-overwrite link/rename can lose the race after the final snapshot.
    // Reinspect both names so the caller receives the exact preserved path
    // instead of a silent false that hides recovery work.
    const racedSource = inspectPath(sourcePath);
    if (racedSource.status !== present || !racedSource.identity?.isFile
        || !victimKeyMatches(racedSource.identity, state, identityKey)) {
      preserveMismatch(context, sourcePath, state.victimKey,
        racedSource.status === present ? identityKey(racedSource.identity) : racedSource.status);
    }
    if (destinationPath && destinationKey !== undefined) {
      const racedDestination = inspectPath(destinationPath);
      const matches = destinationKey === null
        ? racedDestination.status === absent
        : racedDestination.status === present
          && identityKey(racedDestination.identity) === destinationKey;
      if (!matches) {
        preserveMismatch(context, destinationPath, destinationKey,
          racedDestination.status === present
            ? identityKey(racedDestination.identity) : racedDestination.status);
      }
    }
    return false;
  }
  return transactionStillCurrent(markerDir, state, context);
}

export function casMoveVictim(markerDir, state, context, sourcePath, destinationPath, destinationKey,
  helpers) {
  if (!mutateVictimSlot(markerDir, state, context, sourcePath, destinationPath, destinationKey,
    () => linkSync(sourcePath, destinationPath), helpers)) return false;
  const moved = helpers.inspectPath(destinationPath);
  if (moved.status !== helpers.present || !moved.identity?.isFile
      || !victimKeyMatches(moved.identity, state, helpers.identityKey)) {
    preserveMismatch(context, destinationPath, state.victimKey,
      moved.status === helpers.present ? helpers.identityKey(moved.identity) : moved.status);
    return false;
  }
  const source = helpers.inspectPath(sourcePath);
  if (source.status === helpers.present && !victimKeyMatches(source.identity, state, helpers.identityKey)) {
    preserveMismatch(context, sourcePath, state.victimKey, helpers.identityKey(source.identity));
    syncMoveParents(sourcePath, destinationPath);
    return true;
  }
  if (source.status === helpers.present) {
    try { unlinkSync(sourcePath); } catch { return false; }
    syncMoveParents(sourcePath, destinationPath);
  }
  const finalDestination = helpers.inspectPath(destinationPath);
  if (finalDestination.status !== helpers.present || !victimKeyMatches(finalDestination.identity, state, helpers.identityKey)) {
    preserveMismatch(context, destinationPath, state.victimKey,
      finalDestination.status === helpers.present ? helpers.identityKey(finalDestination.identity) : finalDestination.status);
    return false;
  }
  return helpers.transactionStillCurrent(markerDir, state, context);
}

export function casRemoveVictim(markerDir, state, context, sourcePath, helpers) {
  if (!mutateVictimSlot(markerDir, state, context, sourcePath, null, undefined,
    () => unlinkSync(sourcePath), helpers)) return false;
  syncBestEffort(dirname(sourcePath));
  const finalSource = helpers.inspectPath(sourcePath);
  if (finalSource.status !== helpers.absent) {
    preserveMismatch(context, sourcePath, state.victimKey,
      finalSource.status === helpers.present ? helpers.identityKey(finalSource.identity) : finalSource.status);
    return false;
  }
  return helpers.transactionStillCurrent(markerDir, state, context);
}
