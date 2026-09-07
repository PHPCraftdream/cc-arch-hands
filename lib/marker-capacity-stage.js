import { renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { samePathIdentity, streamDirectoryEntries } from './lease-lock.js';
import { syncDirectory } from './fs-atomic-publication.js';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const STAGE_INTERLOCK = 'marker-capacity-stage';

function durableMutation(mutation, directories) {
  mutation();
  for (const directory of directories) syncDirectory(directory);
}

function sameStatusIdentity(inspectPath, path, expected) {
  const current = inspectPath(path);
  if (expected === null) return current.status === 'absent';
  return current.status === 'present' && samePathIdentity(expected, current.identity);
}

function emptyDirectory(path) {
  const entries = [];
  const scan = streamDirectoryEntries(path, 1, (entry) => entries.push(entry.name));
  return scan.complete && entries.length === 0;
}

function stageSnapshot(inspectPath, path) {
  const stage = inspectPath(path);
  if (stage.status !== 'present' || !stage.identity?.isDirectory) return null;
  const entries = [];
  const scan = streamDirectoryEntries(path, 2, (entry) => entries.push(entry.name));
  if (!scan.complete) return null;
  const child = entries.length === 1 && entries[0] === 'transaction.json'
    ? inspectPath(join(path, 'transaction.json'), { content: true })
    : null;
  return { stage, entries, child };
}

function sameContent(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function sameStageSnapshot(inspectPath, path, expected) {
  const current = stageSnapshot(inspectPath, path);
  if (!current || !samePathIdentity(expected.stage.identity, current.stage.identity)) return false;
  if (current.entries.length !== expected.entries.length
      || current.entries.some((entry, index) => entry !== expected.entries[index])) return false;
  if (!expected.child) return current.entries.length === 0;
  return current.child?.status === 'present'
    && current.child.identity?.isFile
    && samePathIdentity(expected.child.identity, current.child.identity)
    && sameContent(expected.child.content, current.child.content);
}

function sameObservedPath(inspectPath, path, expected) {
  const current = inspectPath(path);
  if (expected === null) return current.status === 'absent';
  return current.status === 'present' && samePathIdentity(expected, current.identity);
}

function mutateLegacyCapacityFence(cfg, inspectPath, assertCapacityLease, fence, marker,
  expectedFence, expectedMarker, mutation) {
  // Legacy fences are shared with the old prune/recovery path. The pause is
  // intentionally before the final snapshots so a successor installed while
  // reconciliation is suspended cannot be renamed over or removed.
  cfg.testInterlock?.('marker-capacity-fence', 'before', 'marker-capacity',
    'marker-capacity-stage-legacy');
  if (!assertCapacityLease || !assertCapacityLease()) return false;
  if (!sameObservedPath(inspectPath, fence, expectedFence)
      || !sameObservedPath(inspectPath, marker, expectedMarker)) return false;
  // Keep generation ownership immediately adjacent to the filesystem
  // operation. leaseOwned() includes the persisted generation, while the
  // assertion also rejects a mutated in-memory lease object.
  if (!assertCapacityLease()) return false;
  try {
    mutation();
    return true;
  } catch { return false; }
}

export function reconcileLegacyCapacityFences(markerDir, cfg, capacityLease,
  { inspectPath, sourceWins, capacityLeaseAssertion }) {
  const assertCapacityLease = capacityLeaseAssertion(capacityLease);
  let indeterminate = false;
  const scan = streamDirectoryEntries(markerDir, cfg.scanCap, (entry) => {
    if (!entry.name.endsWith('.cah-capacity-fence')) return;
    const markerName = entry.name.slice(0, -'.cah-capacity-fence'.length);
    if (!cfg.markerNameRe.test(markerName) || !entry.isFile()) return;
    const fence = join(markerDir, entry.name);
    const marker = join(markerDir, markerName);
    const fenceState = inspectPath(fence, { content: true });
    const markerState = inspectPath(marker, { content: true });
    if (fenceState.status === 'indeterminate' || markerState.status === 'indeterminate') {
      indeterminate = true;
      return;
    }
    if (fenceState.status !== 'present') return;
    if (markerState.status === 'absent') {
      if (!mutateLegacyCapacityFence(cfg, inspectPath, assertCapacityLease, fence, marker,
        fenceState.identity, null,
        () => durableMutation(() => renameSync(fence, marker), [markerDir]))) indeterminate = true;
      return;
    }
    if (markerState.status !== 'present') return;
    const winner = sourceWins(fenceState, markerState);
    if (winner === false && !mutateLegacyCapacityFence(cfg, inspectPath, assertCapacityLease,
      fence, marker,
      fenceState.identity, markerState.identity,
      () => durableMutation(() => unlinkSync(fence), [markerDir]))) indeterminate = true;
  });
  return scan.complete && !indeterminate;
}

// The callback is deliberately checked after the test pause and immediately
// before the filesystem operation. A lease can expire while a reconciler is
// paused, and a replacement owner may then reuse the stage pathname.
function mutateStage(cfg, assertCapacityLease, validate, mutation) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!validate()) return false;
    cfg.testInterlock?.(STAGE_INTERLOCK, 'before', 'marker-capacity-stage-reconcile',
      'marker-capacity-stage-legacy');
    // The first validation only avoids entering the test pause for an already
    // changed entry. The second one is the mutation CAS: the complete stage
    // directory and transaction child (including bytes) must still be the
    // snapshot observed before the interlock. Ownership is checked last so a
    // reclaimed capacity lease cannot authorize the filesystem operation.
    if (!validate()) return false;
    if (assertCapacityLease && !assertCapacityLease()) return false;
    try {
      mutation();
      return true;
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt === 4) return false;
    }
  }
  return false;
}

// New transactions use the namespace-local slot. The capacity lease makes
// this one name sufficient and keeps shared-parent enumeration out of the
// publication path.
export function reconcileCapacityStages(markerDir, cfg, helpers) {
  return reconcileCapacityStageSlot(markerDir, cfg, helpers)
    && reconcileLegacyCapacityStages(markerDir, cfg, helpers);
}

function reconcileCapacityStageSlot(markerDir, cfg, { inspectPath, parseTransactionState,
  capacityTransactionPath, capacityStagePath, assertCapacityLease, validateState }) {
  const transactionPath = capacityTransactionPath(markerDir);
  const stagePath = capacityStagePath(markerDir);
  const initial = stageSnapshot(inspectPath, stagePath);
  if (!initial) return inspectPath(stagePath).status === 'absent';
  if (initial.entries.length === 0) {
    return mutateStage(cfg, assertCapacityLease,
      () => sameStageSnapshot(inspectPath, stagePath, initial),
       () => durableMutation(() => rmdirSync(stagePath), [dirname(stagePath)]));
  }
  if (initial.entries.length !== 1 || initial.entries[0] !== 'transaction.json') return false;
  const stagedState = initial.child;
  if (stagedState.status !== 'present' || !stagedState.identity?.isFile
      || !parseTransactionState(stagedState.content)
      || (validateState && !validateState(parseTransactionState(stagedState.content)))) return false;
  const current = inspectPath(transactionPath);
  if (current.status === 'indeterminate') return false;
  const transactionIdentity = current.status === 'present' ? current.identity : null;
  if (current.status === 'absent') {
    return mutateStage(cfg, assertCapacityLease,
      () => sameStageSnapshot(inspectPath, stagePath, initial)
        && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
      () => durableMutation(() => renameSync(stagePath, transactionPath),
        [dirname(stagePath), dirname(transactionPath), transactionPath]));
  }
  if (!mutateStage(cfg, assertCapacityLease,
    () => sameStageSnapshot(inspectPath, stagePath, initial)
      && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
      () => durableMutation(() => unlinkSync(join(stagePath, 'transaction.json')), [stagePath]))) return false;
  const afterChildRemoval = stageSnapshot(inspectPath, stagePath);
  if (!afterChildRemoval || afterChildRemoval.entries.length !== 0) return false;
  return mutateStage(cfg, assertCapacityLease,
    () => sameStageSnapshot(inspectPath, stagePath, afterChildRemoval)
      && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity)
      && emptyDirectory(stagePath),
      () => durableMutation(() => rmdirSync(stagePath), [dirname(stagePath)]));
}

// Compatibility for UUID stage siblings made by older releases. This pass is
// bounded because it is migration support only; fresh work never adds names
// to the shared parent.
//
// Unlike the legacy-fence pass, a truncated scan here is deliberately not a
// failure: the shared parent is populated by unrelated cache entries, so
// hitting the cap is normal steady state (claiming must not stall on it),
// and an unreconciled legacy stage cannot lose a victim, while a legacy
// fence holds victim state and must block when its scan is truncated.
function reconcileLegacyCapacityStages(markerDir, cfg, { inspectPath, parseTransactionState,
  capacityTransactionPath, assertCapacityLease, validateState }) {
  const transactionPath = capacityTransactionPath(markerDir);
  const stagePrefix = `.${basename(markerDir)}-capacity-transaction-stage-`;
  let indeterminate = false;
  streamDirectoryEntries(dirname(markerDir), cfg.scanCap, (entry) => {
    if (!entry.name.startsWith(stagePrefix) || !entry.isDirectory()) return;
    const stagePath = join(dirname(markerDir), entry.name);
    const initial = stageSnapshot(inspectPath, stagePath);
    if (!initial) {
      indeterminate = true;
      return;
    }
    if (initial.entries.length === 0) {
      if (!mutateStage(cfg, assertCapacityLease,
        () => sameStageSnapshot(inspectPath, stagePath, initial),
         () => durableMutation(() => rmdirSync(stagePath), [dirname(stagePath)]))) indeterminate = true;
      return;
    }
    if (initial.entries.length !== 1 || initial.entries[0] !== 'transaction.json') {
      indeterminate = true;
      return;
    }
    const stagedState = initial.child;
    if (stagedState.status !== 'present' || !stagedState.identity?.isFile
        || !parseTransactionState(stagedState.content)
        || (validateState && !validateState(parseTransactionState(stagedState.content)))) {
      indeterminate = true;
      return;
    }
    const current = inspectPath(transactionPath);
    if (current.status === 'indeterminate') { indeterminate = true; return; }
    const transactionIdentity = current.status === 'present' ? current.identity : null;
    if (current.status === 'absent') {
      if (!mutateStage(cfg, assertCapacityLease,
        () => sameStageSnapshot(inspectPath, stagePath, initial)
          && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
         () => durableMutation(() => renameSync(stagePath, transactionPath),
           [dirname(stagePath), dirname(transactionPath), transactionPath]))) indeterminate = true;
      return;
    }
    if (!mutateStage(
      cfg,
      assertCapacityLease,
      () => sameStageSnapshot(inspectPath, stagePath, initial)
        && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
      () => durableMutation(() => unlinkSync(join(stagePath, 'transaction.json')), [stagePath]),
    )) {
      indeterminate = true;
      return;
    }
    const afterChildRemoval = stageSnapshot(inspectPath, stagePath);
    if (!afterChildRemoval || afterChildRemoval.entries.length !== 0) {
      indeterminate = true;
      return;
    }
    if (!mutateStage(
      cfg,
      assertCapacityLease,
      () => sameStageSnapshot(inspectPath, stagePath, afterChildRemoval)
        && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity)
        && emptyDirectory(stagePath),
      () => durableMutation(() => rmdirSync(stagePath), [dirname(stagePath)]),
    )) indeterminate = true;
  });
  return !indeterminate;
}
