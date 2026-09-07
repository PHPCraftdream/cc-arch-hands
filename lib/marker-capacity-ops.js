import {
  linkSync, mkdirSync, renameSync, rmdirSync, unlinkSync,
  openSync, closeSync, fsyncSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { captureRegularFileSnapshot } from './fsutil.js';
import { readPublicationProof, syncDirectory } from './fs-atomic-publication.js';
import { recordDirectoryInspection, streamDirectoryEntriesLookahead } from './lease-lock.js';

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

// A victim is first fenced under a deterministic, transaction-owned name.
// The fence is intentionally a no-overwrite slot: if it is occupied, or if a
// successor wins the pathname race and is the entry that gets moved, the
// entry is retained and reported instead of being unlinked as the victim.
function fenceGeneration(value) {
  const generation = typeof value === 'string' ? value
    : value?.victimFenceGeneration;
  return typeof generation === 'string' && generation
    ? createHash('sha256').update(generation, 'utf8').digest('hex').slice(0, 32) : null;
}

export function victimFencePath(sourcePath, stateOrGeneration = null) {
  const generation = fenceGeneration(stateOrGeneration);
  return join(dirname(sourcePath), `.cah-tmp-victim-${basename(sourcePath)}${generation ? `-${generation}` : ''}`);
}

export function transactionRetirementPath(transactionPath, generation) {
  const key = createHash('sha256').update(String(generation), 'utf8').digest('hex').slice(0, 32);
  return join(transactionPath, `.cah-retired-${key}`);
}

export function transactionRetirementStatePath(transactionPath, generation) {
  return join(transactionRetirementPath(transactionPath, generation), 'transaction.json');
}

export function inspectTransactionRetirement(transactionPath, entries,
  { inspectPath, parseTransactionState, present, indeterminate, validateState = null,
    limit = 16, truncated = false }) {
  const records = [];
  const reservations = [];
  const names = entries.filter((value) => value.startsWith('.cah-retired-')).sort();
  const boundedNames = names.slice(0, Math.max(1, limit));
  const hasMore = truncated || names.length > boundedNames.length;
  for (const name of boundedNames) {
    if (!/^\.cah-retired-[a-f0-9]{32}$/.test(name)) return { status: indeterminate };
    recordDirectoryInspection();
    const rootPath = join(transactionPath, name);
    const root = inspectPath(rootPath);
    if (root.status !== present || !root.identity?.isDirectory) return { status: indeterminate };
    const rootEntries = [];
    const rootScan = streamDirectoryEntriesLookahead(rootPath, 1,
      (entry) => rootEntries.push(entry.name));
    if (!rootScan.complete) return { status: indeterminate };
    const retired = inspectPath(join(rootPath, 'transaction.json'), { content: true });
    if (retired.status === indeterminate) return { status: indeterminate };
    if (retired.status !== present) {
      if (rootEntries.length !== 0) return { status: indeterminate };
      reservations.push({ reservation: true, path: rootPath, identity: root.identity });
      continue;
    }
    if (rootEntries.some((entry) => entry !== 'transaction.json')) {
      return { status: indeterminate };
    }
    const parsed = parseTransactionState(retired.content);
    if (!parsed || (validateState && !validateState(parsed))
        || resolve(transactionRetirementPath(transactionPath,
          parsed.capacityLeaseGeneration)) !== resolve(rootPath)) {
      return { status: indeterminate };
    }
    records.push({
      state: parsed,
      content: retired.content,
      path: rootPath,
      identity: root.identity,
      retiredPath: join(rootPath, 'transaction.json'),
      retiredIdentity: retired.identity,
    });
  }
  return records.length
    ? { status: present, records, reservations,
      truncated: hasMore, ...(records.length === 1 ? records[0] : {}) }
    : reservations.length
      ? { status: present, reservation: reservations[0], reservations, truncated: hasMore }
      : { status: 'absent', reservations: [], truncated: hasMore };
}

function stableTransactionIdentity(identity) {
  if (!identity) return null;
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeNs,
    identity.contentDigest, identity.isFile, identity.isDirectory, identity.isSymbolicLink]
    .map((value) => String(value)).join(':');
}

function directoryIsEmpty(path) {
  const entries = [];
  const scan = streamDirectoryEntriesLookahead(path, 1,
    (entry) => entries.push(entry.name));
  return scan.complete && entries.length === 0;
}

export function retireTransactionState(markerDir, state, context, h) {
  const txDir = h.capacityTransactionPath(markerDir);
  const txPath = h.capacityStatePath(markerDir);
  const retiredDir = transactionRetirementPath(txDir, state.capacityLeaseGeneration);
  const retiredPath = transactionRetirementStatePath(txDir, state.capacityLeaseGeneration);
  const leaseValid = () => Boolean(state?.capacityLeaseGeneration
    && h.transactionLeaseValid(state, context)
    && h.transactionInspection(markerDir, { config: context?.config }).status === h.present);
  // Do not reserve a retirement namespace on behalf of an expired owner. A
  // successor may otherwise inherit an empty reservation that makes its live
  // transaction look ambiguous.
  if (!h.transactionStillCurrent(markerDir, state, context) || !leaseValid()) return false;
  let createdRetiredRoot = null;
  const releaseCreatedReservation = () => {
    if (!createdRetiredRoot) return;
    try {
      const current = h.inspectPath(retiredDir);
      if (current.status !== h.present || !current.identity?.isDirectory
          || stableTransactionIdentity(current.identity) !== createdRetiredRoot
          || !directoryIsEmpty(retiredDir)) return;
      const final = h.inspectPath(retiredDir);
      if (final.status !== h.present || !final.identity?.isDirectory
          || stableTransactionIdentity(final.identity) !== createdRetiredRoot
          || !directoryIsEmpty(retiredDir)) return;
      rmdirSync(retiredDir);
      syncBestEffort(txDir);
    } catch { /* preserve a raced or inaccessible reservation */ }
  };
  const fail = () => { releaseCreatedReservation(); return false; };
  let retiredRoot = h.inspectPath(retiredDir);
  if (retiredRoot.status === h.indeterminate
      || (retiredRoot.status === h.present && !retiredRoot.identity?.isDirectory)) return false;
  const observedRetiredRoot = retiredRoot.status === h.present
    ? stableTransactionIdentity(retiredRoot.identity) : null;
  try {
    if (retiredRoot.status === 'absent') {
      mkdirSync(retiredDir, { mode: 0o700 });
      syncBestEffort(txDir);
      retiredRoot = h.inspectPath(retiredDir);
      if (retiredRoot.status !== h.present || !retiredRoot.identity?.isDirectory) return fail();
      createdRetiredRoot = stableTransactionIdentity(retiredRoot.identity);
      if (!createdRetiredRoot || !h.transactionStillCurrent(markerDir, state, context)
          || !leaseValid()) return fail();
    }
    const retired = h.inspectPath(retiredPath, { content: true });
    if (retired.status === h.indeterminate) return fail();
    if (retired.status !== h.present) {
      if (retiredRoot.status === h.present) {
        const currentRoot = h.inspectPath(retiredDir);
        if (currentRoot.status !== h.present || !currentRoot.identity?.isDirectory
            || (observedRetiredRoot !== null
              && stableTransactionIdentity(currentRoot.identity) !== observedRetiredRoot)
            || !directoryIsEmpty(retiredDir)
            || !h.transactionStillCurrent(markerDir, state, context)) {
          return fail();
        }
        rmdirSync(retiredDir);
        syncBestEffort(txDir);
        mkdirSync(retiredDir, { mode: 0o700 });
        syncBestEffort(txDir);
        retiredRoot = h.inspectPath(retiredDir);
        if (retiredRoot.status !== h.present || !retiredRoot.identity?.isDirectory) return fail();
        createdRetiredRoot = stableTransactionIdentity(retiredRoot.identity);
        if (!createdRetiredRoot || !h.transactionStillCurrent(markerDir, state, context)
            || !leaseValid()) return fail();
      }
      const canonical = h.inspectPath(txPath, { content: true });
      const parsed = canonical.status === h.present ? h.parseTransactionState(canonical.content) : null;
      if (canonical.status !== h.present || !parsed
          || parsed.capacityLeaseGeneration !== state.capacityLeaseGeneration
          || !h.transactionStillCurrent(markerDir, state, context)) return fail();
      context?.testInterlock?.('marker-capacity-transaction-retire', 'before', 'marker-capacity');
      if (!h.transactionStillCurrent(markerDir, state, context)) return fail();
      linkSync(txPath, retiredPath);
      syncBestEffort(retiredDir);
      syncBestEffort(txDir);
      createdRetiredRoot = null;
      if (process.env.CAH_TEST_ONLY === '1'
          && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-transaction-retirement'
            || process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-transaction-quarantine')) process.exit(96);
    }
    const moved = h.inspectPath(retiredPath, { content: true });
    const movedState = moved.status === h.present ? h.parseTransactionState(moved.content) : null;
    if (moved.status !== h.present || !movedState
        || movedState.capacityLeaseGeneration !== state.capacityLeaseGeneration || !leaseValid()) return false;
    const canonical = h.inspectPath(txPath);
    if (canonical.status === h.present
        && stableTransactionIdentity(canonical.identity) !== stableTransactionIdentity(moved.identity)) return false;
    if (canonical.status === h.indeterminate || !leaseValid()) return false;
    if (canonical.status === h.present) {
      context?.testInterlock?.('marker-capacity-transaction-retire-before-unlink', 'before',
        'marker-capacity-transaction-retire');
      const final = h.inspectPath(txPath);
      if (final.status !== h.present || stableTransactionIdentity(final.identity)
          !== stableTransactionIdentity(moved.identity) || !leaseValid()) return false;
      unlinkSync(txPath);
      syncBestEffort(txDir);
    }
    const finalRetired = h.inspectPath(retiredPath, { content: true });
    if (finalRetired.status !== h.present || stableTransactionIdentity(finalRetired.identity)
        !== stableTransactionIdentity(moved.identity) || !h.parseTransactionState(finalRetired.content)
        || !leaseValid()) return false;
    unlinkSync(retiredPath);
    syncBestEffort(retiredDir);
    const emptyRoot = h.inspectPath(retiredDir);
    if (emptyRoot.status !== h.present || !emptyRoot.identity?.isDirectory
        || !directoryIsEmpty(retiredDir) || !h.transactionLeaseValid(state, context)) return false;
    rmdirSync(retiredDir);
    syncBestEffort(txDir);
    return true;
  } catch { return fail(); }
}

function victimFencePayload(fencePath) { return join(fencePath, 'payload'); }

function testVictimCrash() {
  return process.env.CAH_TEST_ONLY === '1'
    && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-victim-quarantine'
      || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-victim-quarantine');
}

function fenceMatches(fence, state, helpers) {
  return fence.status === helpers.present && fence.identity?.isFile
    && victimKeyMatches(fence.identity, state, helpers.identityKey);
}

function directoryKey(identity) {
  if (!identity) return null;
  return [identity.dev, identity.ino, identity.mode, identity.isDirectory,
    identity.isSymbolicLink].map((value) => String(value)).join(':');
}

function releaseEmptyVictimFence(fencePath, expectedKey = null, helpers = null, assertOwner = null) {
  if (helpers) {
    const current = helpers.inspectPath(fencePath);
    if (!current?.identity || directoryKey(current.identity) !== expectedKey) return false;
  }
  if (assertOwner && !assertOwner()) return false;
  try {
    rmdirSync(fencePath);
    syncBestEffort(dirname(fencePath));
    return true;
  } catch { return false; }
}

function persistedGeneration(state) {
  return typeof state?.capacityLeaseGeneration === 'string'
    && state.capacityLeaseGeneration ? state.capacityLeaseGeneration : null;
}

function fenceUnlinkReady(markerDir, state, context, payloadPath, expectedKey, helpers) {
  const current = helpers.inspectPath(payloadPath);
  if (!fenceMatches(current, state, helpers)
      || helpers.identityKey(current.identity) !== expectedKey) return false;
  // Keep the persisted generation assertion after the exact identity read so
  // this check is the last ownership gate before the payload unlink.
  return Boolean(persistedGeneration(state))
    && helpers.transactionStillCurrent(markerDir, state, context);
}

function removeVictimFence(markerDir, state, context, fencePath, helpers) {
  if (!helpers.transactionStillCurrent(markerDir, state, context)) return false;
  const root = helpers.inspectPath(fencePath);
  const rootKey = directoryKey(root.identity);
  if (root.status !== helpers.present || !root.identity?.isDirectory || !rootKey) return false;
  const fenced = helpers.inspectPath(victimFencePayload(fencePath));
  if (!fenceMatches(fenced, state, helpers)) {
    if (fenced.status !== helpers.absent) preserveMismatch(context, fencePath, state.victimKey,
      fenced.status === helpers.present ? helpers.identityKey(fenced.identity) : fenced.status);
    return fenced.status === helpers.absent;
  }
  if (!helpers.transactionStillCurrent(markerDir, state, context)) return false;
  const finalFence = helpers.inspectPath(victimFencePayload(fencePath));
  if (!fenceMatches(finalFence, state, helpers)) {
    preserveMismatch(context, fencePath, state.victimKey,
      finalFence.status === helpers.present ? helpers.identityKey(finalFence.identity) : finalFence.status);
    return false;
  }
  if (testVictimCrash()) process.exit(94);
  context?.testInterlock?.('marker-capacity-victim-unlink', 'before', 'marker-capacity');
  const unlinkKey = helpers.identityKey(finalFence.identity);
  // The generation and exact payload identity are checked again immediately
  // before unlink. A stale owner must leave a successor's recovery artifact.
  if (!fenceUnlinkReady(markerDir, state, context,
    victimFencePayload(fencePath), unlinkKey, helpers)) {
    preserveMismatch(context, fencePath, state.victimKey, 'ownership-or-identity-changed');
    return false;
  }
  try {
    unlinkSync(victimFencePayload(fencePath));
    syncBestEffort(fencePath);
    const finalRoot = helpers.inspectPath(fencePath);
    if (finalRoot.status !== helpers.present || !finalRoot.identity?.isDirectory
        || directoryKey(finalRoot.identity) !== rootKey
        || !persistedGeneration(state)
        || !helpers.transactionStillCurrent(markerDir, state, context)) {
      preserveMismatch(context, fencePath, state.victimKey,
        finalRoot.status === helpers.present ? directoryKey(finalRoot.identity) : finalRoot.status);
      return false;
    }
    rmdirSync(fencePath);
  } catch { return false; }
  syncBestEffort(dirname(fencePath));
  const after = helpers.inspectPath(fencePath);
  if (after.status !== helpers.absent) {
    preserveMismatch(context, fencePath, state.victimKey,
      after.status === helpers.present ? helpers.identityKey(after.identity) : after.status);
    return false;
  }
  return true;
}

function fenceAndRemoveVictim(markerDir, state, context, sourcePath, helpers) {
  const fencePath = victimFencePath(sourcePath, state);
  const occupied = helpers.inspectPath(fencePath);
  if (occupied.status !== helpers.absent) {
    preserveMismatch(context, fencePath, state.victimKey,
      occupied.status === helpers.present ? helpers.identityKey(occupied.identity) : occupied.status);
    return false;
  }
  try { mkdirSync(fencePath, { mode: 0o700 }); } catch {
    preserveMismatch(context, fencePath, state.victimKey, 'occupied');
    return false;
  }
  const fenceRoot = helpers.inspectPath(fencePath);
  const fenceRootKey = directoryKey(fenceRoot.identity);
  if (!helpers.transactionStillCurrent(markerDir, state, context)) {
    return false;
  }
  const source = helpers.inspectPath(sourcePath);
  if (!fenceMatches(source, state, helpers)) {
    preserveMismatch(context, sourcePath, state.victimKey,
      source.status === helpers.present ? helpers.identityKey(source.identity) : source.status);
    releaseEmptyVictimFence(fencePath, fenceRootKey, helpers,
      () => Boolean(persistedGeneration(state)) && helpers.transactionStillCurrent(markerDir, state, context));
    return false;
  }
  context?.testInterlock?.('marker-capacity-victim-fence', 'before', 'marker-capacity');
  if (!helpers.transactionStillCurrent(markerDir, state, context)) {
    return false;
  }
  const finalSource = helpers.inspectPath(sourcePath);
  const finalFence = helpers.inspectPath(victimFencePayload(fencePath));
  if (finalFence.status !== helpers.absent || !fenceMatches(finalSource, state, helpers)) {
    if (finalFence.status !== helpers.absent) preserveMismatch(context, fencePath, state.victimKey,
      finalFence.status === helpers.present ? helpers.identityKey(finalFence.identity) : finalFence.status);
    if (!fenceMatches(finalSource, state, helpers)) preserveMismatch(context, sourcePath, state.victimKey,
      finalSource.status === helpers.present ? helpers.identityKey(finalSource.identity) : finalSource.status);
    if (finalFence.status === helpers.absent) {
      releaseEmptyVictimFence(fencePath, fenceRootKey, helpers,
        () => Boolean(persistedGeneration(state)) && helpers.transactionStillCurrent(markerDir, state, context));
    }
    return false;
  }
  context?.testInterlock?.('marker-capacity-victim-rename', 'before', 'marker-capacity');
  try {
    renameSync(sourcePath, victimFencePayload(fencePath));
    syncMoveParents(sourcePath, victimFencePayload(fencePath));
  } catch { return false; }
  const moved = helpers.inspectPath(victimFencePayload(fencePath));
  if (!fenceMatches(moved, state, helpers)) {
    preserveMismatch(context, fencePath, state.victimKey,
      moved.status === helpers.present ? helpers.identityKey(moved.identity) : moved.status);
    return false;
  }
  context?.testInterlock?.('marker-capacity-victim-fence', 'after', 'marker-capacity');
  return removeVictimFence(markerDir, state, context, fencePath, helpers);
}

export function recoverVictimFence(markerDir, state, context, sourcePath, helpers) {
  const generationFence = victimFencePath(sourcePath, state);
  const fencePath = state?.victimFenceGeneration
    ? generationFence : victimFencePath(sourcePath);
  const fenceRoot = helpers.inspectPath(fencePath);
  if (fenceRoot.status === (helpers.indeterminate || 'indeterminate')) return false;
  if (fenceRoot.status === helpers.present && !fenceRoot.identity?.isDirectory) {
    preserveMismatch(context, fencePath, state.victimKey, helpers.identityKey(fenceRoot.identity));
    return false;
  }
  const fence = helpers.inspectPath(victimFencePayload(fencePath));
  if (fence.status === helpers.absent && fenceRoot.status === helpers.present) {
    const rootKey = directoryKey(fenceRoot.identity);
    if (!rootKey || !persistedGeneration(state)
        || !helpers.transactionStillCurrent(markerDir, state, context)) return false;
    const finalRoot = helpers.inspectPath(fencePath);
    if (finalRoot.status !== helpers.present || !finalRoot.identity?.isDirectory
        || directoryKey(finalRoot.identity) !== rootKey
        || !helpers.transactionStillCurrent(markerDir, state, context)) {
      preserveMismatch(context, fencePath, state.victimKey,
        finalRoot.status === helpers.present ? directoryKey(finalRoot.identity) : finalRoot.status);
      return false;
    }
    return releaseEmptyVictimFence(fencePath, rootKey, helpers,
      () => Boolean(persistedGeneration(state)) && helpers.transactionStillCurrent(markerDir, state, context));
  }
  if (fence.status === helpers.absent) return true;
  if (!fenceMatches(fence, state, helpers)) {
    preserveMismatch(context, fencePath, state.victimKey,
      fence.status === helpers.present ? helpers.identityKey(fence.identity) : fence.status);
    return false;
  }
  return removeVictimFence(markerDir, state, context, fencePath, helpers);
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
  { inspectPath, capacitySlotPath, parseTransactionState, identityKey, present, indeterminate,
    validateState = null } = {}) {
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
  if (!parsed || (validateState && !validateState(parsed))
      || resolve(dirname(parsed.marker)) !== resolve(markerDir)
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
  if (typeof assertOwnership !== 'function' || !assertOwnership()) {
    return { recognized: true, state: null };
  }
  const current = inspectPath(statePath);
  if (current.status === indeterminate) return { recognized: true, state: null };
  let linkedState = false;
  if (current.status === 'absent') {
    try {
      if (!assertOwnership()) return { recognized: true, state: null };
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
        const rollbackKey = identityKey
          ? identityKey(currentState.identity) : null;
        const restoredKey = identityKey ? identityKey(restored.identity) : null;
        const finalState = inspectPath(statePath);
        const exact = finalState.status === present
          && proofIdentityMatches(finalState.identity, restored.identity)
          && (!identityKey || (identityKey(finalState.identity) === rollbackKey
            && identityKey(finalState.identity) === restoredKey));
        // assertOwnership is deliberately the final check before rollback.
        if (exact && (!parsed.capacityLeaseGeneration
          || typeof assertOwnership !== 'function' || !assertOwnership())) return { recognized: true, state: null };
        if (exact) {
          try { unlinkSync(statePath); syncBestEffort(dirname(statePath)); } catch { /* preserve */ }
        }
      }
    }
    return { recognized: true, state: null };
  }
  const restoredState = parseTransactionState(restored.content);
  if (!restoredState) return { recognized: true, state: null };
  const tempAfter = inspectPath(proof.tempPath);
  if (tempAfter.status === present && proofIdentityMatches(tempAfter.identity, proof.tempIdentity)) {
    try {
      const tempKey = identityKey ? identityKey(tempAfter.identity) : null;
      const finalTemp = inspectPath(proof.tempPath);
      if (finalTemp.status !== present || !proofIdentityMatches(finalTemp.identity, proof.tempIdentity)
          || (identityKey && identityKey(finalTemp.identity) !== tempKey)
          || !parsed.capacityLeaseGeneration || typeof assertOwnership !== 'function'
          || !assertOwnership()) return { recognized: true, state: null };
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
    () => {
      linkSync(sourcePath, destinationPath);
      // The destination link must be durable before the source is fenced or a
      // crash can lose the only durable reference used for restoration.
      syncBestEffort(dirname(destinationPath));
    }, helpers)) return false;
  const moved = helpers.inspectPath(destinationPath);
  if (moved.status !== helpers.present || !moved.identity?.isFile
      || !victimKeyMatches(moved.identity, state, helpers.identityKey)) {
    preserveMismatch(context, destinationPath, state.victimKey,
      moved.status === helpers.present ? helpers.identityKey(moved.identity) : moved.status);
    return false;
  }
  const source = helpers.inspectPath(sourcePath);
  if (source.status === helpers.present) {
    if (!fenceAndRemoveVictim(markerDir, state, context, sourcePath, helpers)) return false;
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
    () => {}, helpers)) return false;
  if (!fenceAndRemoveVictim(markerDir, state, context, sourcePath, helpers)) return false;
  const finalSource = helpers.inspectPath(sourcePath);
  if (finalSource.status !== helpers.absent) {
    preserveMismatch(context, sourcePath, state.victimKey,
      finalSource.status === helpers.present ? helpers.identityKey(finalSource.identity) : finalSource.status);
    return false;
  }
  return helpers.transactionStillCurrent(markerDir, state, context);
}
