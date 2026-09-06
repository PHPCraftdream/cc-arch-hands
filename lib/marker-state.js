// Shared bounded marker state for the hint and update hooks.
//
// Marker state is deliberately kept in a namespace owned by one feature. The
// old flat locations remain readable for one bounded migration pass, but all
// destructive work is serialized by the namespace capacity lease.

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync,
  lstatSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  acquireLease, leaseOwned, pathIdentity, releaseLease, samePathIdentity,
  streamDirectoryEntries, removePathIfUnchangedRecoverable, waitForLeaseTestInterlock,
} from './lease-lock.js';
import { captureRegularFileSnapshot, isOlderThan, writeFileAtomic } from './fsutil.js';

const TX_VERSION = 2;
const MIGRATION_VERSION = 1;
const ABSENT = 'absent';
const PRESENT = 'present';
const INDETERMINATE = 'indeterminate';

export const INSPECTION = Object.freeze({ ABSENT, PRESENT, INDETERMINATE });

function testOnlyFailure(name) {
  return process.env.CAH_TEST_ONLY === '1' && process.env[name] === '1';
}

// Unlike pathIdentity(), this function never folds an unreadable path into
// "absent".  A failed inspection is not permission to restore or delete it.
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
    markerNameRe: options.markerNameRe || new RegExp(`^${escapeRegExp(options.prefix)}[a-f0-9]{64}$`),
    legacyRoots: options.legacyRoots,
  };
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function capacityTransactionPath(markerDir) {
  return join(dirname(markerDir), `.${basename(markerDir)}-capacity-transaction`);
}

function capacityStatePath(markerDir) { return join(capacityTransactionPath(markerDir), 'transaction.json'); }
function capacitySlotPath(markerDir) { return join(capacityTransactionPath(markerDir), 'victim'); }

function ownerToken(owner) { return owner?.nonce || owner?.token || null; }

function semanticRecord(data) {
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

function semanticFreshness(path, inspected) {
  if (inspected.status !== PRESENT) return null;
  const record = semanticRecord(inspected.content);
  const mtime = inspected.identity?.mtimeNs;
  const mtimeNumber = typeof mtime === 'bigint' ? Number(mtime) : Number(mtime);
  return {
    delivered: record.delivered ? 1 : 0,
    time: record.time === null ? -1 : record.time,
    mtime: Number.isFinite(mtimeNumber) ? mtimeNumber : -1,
    path,
  };
}

function compareFreshness(left, right) {
  if (!left || !right) return null;
  for (const key of ['delivered', 'time', 'mtime']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

function sourceWins(source, target) {
  const left = semanticFreshness(source.path, source);
  const right = semanticFreshness(target.path, target);
  const result = compareFreshness(left, right);
  return result === null ? null : result > 0;
}

function migrationSentinel(markerDir) { return join(markerDir, '.migration-v1'); }

function claimPath(marker) { return join(dirname(marker), `.cah-marker-claim-${basename(marker)}`); }

function leaseOptions(cfg, phase = 'claim-reclaim') {
  return {
    staleAfterMs: cfg.claimTtlMs,
    fenceSuffix: '.taken-',
    interlockPhase: phase,
    releaseInterlockPhase: phase === 'claim-reclaim' ? 'claim-release' : `${phase}-release`,
    testLeaseEnv: cfg.ownerTestEnv,
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

function transactionInspection(markerDir) {
  const tx = inspectPath(capacityTransactionPath(markerDir));
  if (tx.status === ABSENT) return { status: ABSENT, state: null };
  if (tx.status === INDETERMINATE || !tx.identity?.isDirectory) {
    return { status: INDETERMINATE, state: null };
  }
  const state = inspectPath(capacityStatePath(markerDir), { content: true });
  if (state.status !== PRESENT || !state.identity?.isFile) {
    return { status: state.status === ABSENT ? INDETERMINATE : state.status, state: null };
  }
  try {
    const parsed = JSON.parse(state.content.toString('utf8'));
    if (parsed?.version !== TX_VERSION || typeof parsed.marker !== 'string'
        || typeof parsed.victim !== 'string' || typeof parsed.victimKey !== 'string'
        || typeof parsed.markerBeforeKey !== 'string' || typeof parsed.nonce !== 'string'
        || typeof parsed.markerClaimPath !== 'string' || typeof parsed.victimClaimPath !== 'string'
        || typeof parsed.capacityLeasePath !== 'string') {
      return { status: INDETERMINATE, state: null };
    }
    return { status: PRESENT, state: parsed };
  } catch {
    return { status: INDETERMINATE, state: null };
  }
}

function readTransaction(markerDir) {
  const result = transactionInspection(markerDir);
  return result.status === ABSENT ? undefined : result.status === PRESENT ? result.state : null;
}

function transactionLeaseValid(state, context, { requireSession = true } = {}) {
  if (!state || !context?.capacityLease || !leaseOwned(context.capacityLease)) return false;
  if ((!context.recovered && ownerToken(context.capacityLease.owner) !== state.capacityLeaseToken)
      || context.capacityLease.path !== state.capacityLeasePath) return false;
  if (requireSession && (!context.sessionClaim?.lease || !leaseOwned(context.sessionClaim.lease)
      || (!context.recovered && ownerToken(context.sessionClaim.lease.owner) !== state.sessionLeaseToken)
      || context.sessionClaim.lease.path !== state.markerClaimPath)) return false;
  if (context.victimClaim
      && (!leaseOwned(context.victimClaim.lease)
        || (!context.recovered && ownerToken(context.victimClaim.lease.owner) !== state.victimLeaseToken)
        || context.victimClaim.lease.path !== state.victimClaimPath)) return false;
  return true;
}

function transactionStillCurrent(markerDir, state, context, options = {}) {
  if (!transactionLeaseValid(state, context, options)) return false;
  const current = transactionInspection(markerDir);
  return current.status === PRESENT && current.state.nonce === state.nonce;
}

function publicationStatus(state) {
  const marker = inspectPath(state.marker, { content: true });
  if (marker.status === INDETERMINATE) return INDETERMINATE;
  if (marker.status === ABSENT || !marker.identity?.isFile) return ABSENT;
  if (identityKey(marker.identity) === state.markerBeforeKey) return ABSENT;
  const record = semanticRecord(marker.content);
  let parsed = null;
  try { parsed = JSON.parse(marker.content.toString('utf8')); } catch { /* legacy payload */ }
  if (parsed && ownerToken(parsed) === state.nonce) return PRESENT;
  // Migration payloads may be legacy bytes. A changed marker under all live
  // leases is still a publication; a restart can safely treat its newer mtime
  // as the successor and converge without deleting newer state.
  if (state.markerBeforeKey === 'absent' && record.time === null) return PRESENT;
  return state.markerPublishedKey && identityKey(marker.identity) === state.markerPublishedKey
    ? PRESENT : INDETERMINATE;
}

function cleanupTransaction(markerDir, state, context) {
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  const tx = inspectPath(capacityStatePath(markerDir), { content: true });
  if (tx.status !== PRESENT || !samePathIdentity(tx.identity, pathIdentity(capacityStatePath(markerDir)))) return false;
  try {
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    unlinkSync(capacityStatePath(markerDir));
    const dir = inspectPath(capacityTransactionPath(markerDir));
    if (dir.status === INDETERMINATE) return false;
    if (dir.status === PRESENT) rmdirSync(capacityTransactionPath(markerDir));
    return true;
  } catch { return false; }
}

function restoreVictim(markerDir, state, context) {
  const slot = inspectPath(capacitySlotPath(markerDir));
  const canonical = inspectPath(state.victim, { content: true });
  if (slot.status === INDETERMINATE || canonical.status === INDETERMINATE) return false;
  if (slot.status === ABSENT) return canonical.status === PRESENT;
  if (canonical.status === ABSENT) {
    if (!transactionStillCurrent(markerDir, state, context)) return false;
    try { renameSync(capacitySlotPath(markerDir), state.victim); return true; } catch { return false; }
  }
  // A newer successor owns the canonical name. It wins; remove only the old
  // displaced victim. If ordering is unavailable, preserve both.
  const victimFresh = semanticFreshness(state.victim, slot);
  const successorFresh = semanticFreshness(state.victim, canonical);
  if (compareFreshness(successorFresh, victimFresh) === null
      || compareFreshness(successorFresh, victimFresh) < 0) return false;
  if (!transactionStillCurrent(markerDir, state, context)) return false;
  try { unlinkSync(capacitySlotPath(markerDir)); return true; } catch { return false; }
}

export function finishCapacityEviction(markerDir, state, context) {
  if (!state || !transactionStillCurrent(markerDir, state, context)) return false;
  const publication = publicationStatus(state);
  if (publication === INDETERMINATE || publication !== PRESENT) return false;
  const slot = inspectPath(capacitySlotPath(markerDir));
  if (slot.status === INDETERMINATE) return false;
  try {
    if (slot.status === ABSENT) {
      const victim = inspectPath(state.victim);
      if (victim.status === INDETERMINATE) return false;
      if (victim.status === PRESENT) {
        if (!transactionStillCurrent(markerDir, state, context)) return false;
        if (identityKey(victim.identity) !== state.victimKey) return false;
        renameSync(state.victim, capacitySlotPath(markerDir));
      }
    }
    if (testOnlyFailure('CAH_TEST_ONLY_FINAL_UNLINK_FAILURE')
        || testOnlyFailure('CAH_TEST_ONLY_MARKER_FINAL_UNLINK_FAILURE')
        || testOnlyFailure('CAH_TEST_ONLY_CAPACITY_UNLINK_FAILURE')) return false;
    const finalSlot = inspectPath(capacitySlotPath(markerDir));
    if (finalSlot.status === INDETERMINATE) return false;
    if (finalSlot.status === PRESENT) {
      if (!transactionStillCurrent(markerDir, state, context)) return false;
      unlinkSync(capacitySlotPath(markerDir));
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

function reconcileLegacyCapacityFences(markerDir, cfg) {
  let indeterminate = false;
  const scan = streamDirectoryEntries(markerDir, cfg.scanCap, (entry) => {
    if (!entry.name.endsWith('.cah-capacity-fence')) return;
    const markerName = entry.name.slice(0, -'.cah-capacity-fence'.length);
    if (!cfg.markerNameRe.test(markerName) || !entry.isFile()) return;
    const fence = join(markerDir, entry.name);
    const marker = join(markerDir, markerName);
    const fenceState = inspectPath(fence);
    const markerState = inspectPath(marker);
    if (fenceState.status === INDETERMINATE || markerState.status === INDETERMINATE) {
      indeterminate = true;
      return;
    }
    if (fenceState.status !== PRESENT) return;
    try {
      if (markerState.status === ABSENT) renameSync(fence, marker);
      else if (markerState.status === PRESENT) {
        const winner = sourceWins(fenceState, markerState);
        if (winner === false) unlinkSync(fence);
      }
    } catch { /* retry on a later bounded pass */ }
  });
  return scan.complete && !indeterminate;
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

function prepareCapacityEviction(markerDir, marker, markerBefore, nonce, nowMs, cfg, context, excludedPath = null) {
  const tx = readTransaction(markerDir);
  if (tx === null) return null;
  if (tx) {
    if (!transactionLeaseValid(tx, context)) return null;
    if (!abortCapacityEviction(markerDir, tx, context)) return null;
  }
  if (!reconcileLegacyCapacityFences(markerDir, cfg)) return null;
  const scan = scanCapacity(markerDir, cfg, marker, excludedPath, nowMs);
  if (!scan.complete) return null;
  if (scan.count < cfg.maxSessions || !scan.oldest) return { state: null, victimClaim: null };
  const victimClaim = acquireClaim(scan.oldest.path, nowMs, cfg);
  if (!victimClaim) return null;
  const txDir = capacityTransactionPath(markerDir);
  const txState = capacityStatePath(markerDir);
  const state = {
    version: TX_VERSION,
    marker,
    markerBeforeKey: identityKey(markerBefore) || 'absent',
    nonce,
    victim: scan.oldest.path,
    victimKey: identityKey(scan.oldest.identity),
    markerClaimPath: context.sessionClaim.lease.path,
    markerClaimToken: ownerToken(context.sessionClaim.owner),
    sessionLeaseToken: ownerToken(context.sessionClaim.owner),
    victimClaimPath: victimClaim.claimPath,
    victimLeaseToken: ownerToken(victimClaim.owner),
    capacityLeasePath: context.capacityLease.path,
    capacityLeaseToken: ownerToken(context.capacityLease.owner),
    preparedAt: nowMs,
  };
  try {
    mkdirSync(txDir, { recursive: true });
    const existing = inspectPath(txState, { content: true });
    if (existing.status !== ABSENT) throw new Error('capacity transaction already exists');
    writeFileSync(txState, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    const victim = inspectPath(scan.oldest.path);
    if (victim.status !== PRESENT || !samePathIdentity(scan.oldest.identity, victim.identity)
        || !transactionStillCurrent(markerDir, state, context)) throw new Error('victim changed');
    waitForLeaseTestInterlock('marker-capacity');
    const finalVictim = inspectPath(scan.oldest.path);
    if (finalVictim.status !== PRESENT || !samePathIdentity(scan.oldest.identity, finalVictim.identity)
        || !transactionStillCurrent(markerDir, state, context)) {
      restoreVictim(markerDir, state, context);
      cleanupTransaction(markerDir, state, context);
      releaseMarkerClaim(victimClaim);
      return prepareCapacityEviction(markerDir, marker, markerBefore, nonce, nowMs, cfg, context, scan.oldest.path);
    }
    renameSync(scan.oldest.path, capacitySlotPath(markerDir));
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
        migrationContext,
      );
      if (!migrationTransaction) return INDETERMINATE;
      migrationClaim.victimClaim = migrationTransaction.victimClaim;
      migrationContext.victimClaim = migrationTransaction.victimClaim;
      expected.exists = false;
    }
    writeFileAtomic(targetPath, source.content, { expectedDestination: expected });
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
    // Source state is fresher. Replace a target only after both lease paths
    // have been acquired; a live target or source remains authoritative and
    // is retried later rather than being discarded.
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
  // The current namespace owns the equal/newer claim. Reclaim only the old
  // legacy owner; a live legacy owner intentionally blocks duplicate work.
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

export function migrateMarkerState(options) {
  const cfg = configOf(options);
  const { home, sessionId } = options;
  const markerDir = cfg.markerDir || markerNamespace(home, cfg.namespace);
  try { mkdirSync(markerDir, { recursive: true }); } catch { return { blocked: true }; }

  // Direct current-session migration always runs, including after the
  // sentinel. This is what lets an old live owner converge beyond scan caps.
  const roots = [...new Set((cfg.legacyRoots || [cacheRoot(home), join(home, '.claude')]).filter(Boolean))];
  let blocked = false;
  const sentinel = migrationSentinel(markerDir);
  const migrationLease = acquireLease(join(markerDir, `.cah-marker-capacity-${cfg.namespace}`), {
    nowMs: Date.now(), ...leaseOptions(cfg, 'marker-capacity-lease-reclaim'),
  });
  if (!migrationLease) return { blocked: true };
  try {
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
    for (const root of roots) {
      const scan = streamDirectoryEntries(root, cfg.scanCap, (entry) => {
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
      // A shared legacy root may contain more unrelated entries than the
      // bounded scan. That is not a current-session failure; leave the
      // sentinel absent so a later invocation can converge the overflow.
    }
    try { writeFileSync(sentinel, `v${MIGRATION_VERSION}\n`, { flag: 'wx' }); } catch { /* another worker won */ }
  } finally { releaseLease(migrationLease); }
  return { blocked };
}

// The stamp throttle has the same legacy collision and bounded-scan rules,
// but its files are session sidecars rather than marker leaves. Keeping this
// small adapter here prevents the two bins from growing subtly different
// migration CAS rules.
export function migrateLegacyStateFiles(options) {
  const cfg = configOf(options);
  const { home, sessionId, namespaceDir, stateName, lockName, prefix } = options;
  const namespace = namespaceDir;
  try { mkdirSync(namespace, { recursive: true }); } catch { return { blocked: true }; }
  const roots = [...new Set((options.roots || [dirname(namespace), cacheRoot(home)]).filter(Boolean))];
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
  for (const root of roots) {
    const scan = streamDirectoryEntries(root, options.scanCap, (entry) => {
      if (!entry.name.startsWith(prefix)) return;
      if (entry.name.endsWith('.json.lock') && entry.isDirectory()) migrateRoot(root, entry.name, true);
      else if (entry.name.endsWith('.json') && entry.isFile()) migrateRoot(root, entry.name, false);
    });
    // Bounded overflow is retried, but does not suppress current-session work.
    if (!scan.complete) continue;
  }
  try { writeFileSync(sentinel, `v${MIGRATION_VERSION}\n`, { flag: 'wx' }); } catch { /* another worker won */ }
  return { blocked };
}

export function pruneMarkers(options) {
  const cfg = configOf(options);
  const nowMs = options.nowMs ?? Date.now();
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
          && markerClaimOwned(claim)) removePathIfUnchangedRecoverable(path, current.identity, 'marker-remove');
    } finally { releaseMarkerClaim(claim); }
  });
  return result.complete;
}

export function claimMarker(options) {
  const cfg = configOf(options);
  const markerDir = cfg.markerDir;
  const nowMs = options.nowMs ?? Date.now();
  const marker = options.marker || join(markerDir, `${cfg.prefix}${sessionHash(options.sessionId)}`);
  try { mkdirSync(markerDir, { recursive: true }); } catch { return null; }
  const capacityLease = acquireLease(join(markerDir, `.cah-marker-capacity-${cfg.namespace}`), {
    nowMs, ...leaseOptions(cfg, 'marker-capacity-lease-reclaim'),
  });
  if (!capacityLease) return null;
  const tx = readTransaction(markerDir);
  if (tx === null) { releaseLease(capacityLease); return null; }
  const recoveredContext = { capacityLease, recovered: true };
  if (tx) {
    // Re-acquire the old session/victim claim paths before touching a restart
    // transaction. A live owner blocks recovery; stale leases are fenced by
    // lease-lock and the persisted nonce still has to match below.
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
  const context = { capacityLease, sessionClaim };
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
    writeFileAtomic(claim.marker, payload, { expectedDestination });
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
