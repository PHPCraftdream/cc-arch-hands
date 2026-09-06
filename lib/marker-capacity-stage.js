import { renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { samePathIdentity, streamDirectoryEntries } from './lease-lock.js';

// New transactions use the namespace-local slot. The capacity lease makes
// this one name sufficient and keeps shared-parent enumeration out of the
// publication path.
export function reconcileCapacityStages(markerDir, cfg, helpers) {
  return reconcileCapacityStageSlot(markerDir, helpers)
    && reconcileLegacyCapacityStages(markerDir, cfg, helpers);
}

function reconcileCapacityStageSlot(markerDir, { inspectPath, parseTransactionState,
  capacityTransactionPath, capacityStagePath }) {
  const transactionPath = capacityTransactionPath(markerDir);
  const stagePath = capacityStagePath(markerDir);
  const stage = inspectPath(stagePath);
  if (stage.status === 'absent') return true;
  if (stage.status !== 'present' || !stage.identity?.isDirectory) return false;
  const entries = [];
  if (!streamDirectoryEntries(stagePath, 2, (entry) => entries.push(entry.name)).complete) return false;
  if (entries.length === 0) {
    const currentStage = inspectPath(stagePath);
    if (currentStage.status !== 'present' || !samePathIdentity(stage.identity, currentStage.identity)) return false;
    try { rmdirSync(stagePath); return true; } catch { return false; }
  }
  if (entries.length !== 1 || entries[0] !== 'transaction.json') return false;
  const stagedState = inspectPath(join(stagePath, 'transaction.json'), { content: true });
  if (stagedState.status !== 'present' || !stagedState.identity?.isFile
      || !parseTransactionState(stagedState.content)) return false;
  const currentStage = inspectPath(stagePath);
  if (currentStage.status !== 'present' || !samePathIdentity(stage.identity, currentStage.identity)) return false;
  const current = inspectPath(transactionPath);
  if (current.status === 'indeterminate') return false;
  try {
    if (current.status === 'absent') renameSync(stagePath, transactionPath);
    else {
      unlinkSync(join(stagePath, 'transaction.json'));
      rmdirSync(stagePath);
    }
    return true;
  } catch { return false; }
}

// Compatibility for UUID stage siblings made by older releases. This pass is
// bounded because it is migration support only; fresh work never adds names
// to the shared parent.
function reconcileLegacyCapacityStages(markerDir, cfg, { inspectPath, parseTransactionState,
  capacityTransactionPath }) {
  const transactionPath = capacityTransactionPath(markerDir);
  const stagePrefix = `.${basename(markerDir)}-capacity-transaction-stage-`;
  let indeterminate = false;
  streamDirectoryEntries(dirname(markerDir), cfg.scanCap, (entry) => {
    if (!entry.name.startsWith(stagePrefix) || !entry.isDirectory()) return;
    const stagePath = join(dirname(markerDir), entry.name);
    const stage = inspectPath(stagePath);
    if (stage.status !== 'present' || !stage.identity?.isDirectory) {
      indeterminate = true;
      return;
    }
    const entries = [];
    if (!streamDirectoryEntries(stagePath, 2, (stageEntry) => entries.push(stageEntry.name)).complete) {
      indeterminate = true;
      return;
    }
    if (entries.length === 0) {
      const currentStage = inspectPath(stagePath);
      if (currentStage.status !== 'present'
          || !samePathIdentity(stage.identity, currentStage.identity)) {
        indeterminate = true;
        return;
      }
      try { rmdirSync(stagePath); } catch { indeterminate = true; }
      return;
    }
    if (entries.length !== 1 || entries[0] !== 'transaction.json') {
      indeterminate = true;
      return;
    }
    const stagedState = inspectPath(join(stagePath, 'transaction.json'), { content: true });
    if (stagedState.status !== 'present' || !stagedState.identity?.isFile
        || !parseTransactionState(stagedState.content)) {
      indeterminate = true;
      return;
    }
    const currentStage = inspectPath(stagePath);
    if (currentStage.status !== 'present' || !samePathIdentity(stage.identity, currentStage.identity)) {
      indeterminate = true;
      return;
    }
    const current = inspectPath(transactionPath);
    if (current.status === 'indeterminate') { indeterminate = true; return; }
    try {
      if (current.status === 'absent') renameSync(stagePath, transactionPath);
      else {
        unlinkSync(join(stagePath, 'transaction.json'));
        rmdirSync(stagePath);
      }
    } catch { indeterminate = true; }
  });
  return !indeterminate;
}
