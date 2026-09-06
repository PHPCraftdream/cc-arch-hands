import { renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { samePathIdentity, streamDirectoryEntries } from './lease-lock.js';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const STAGE_INTERLOCK = 'marker-capacity-stage';

function sameStatusIdentity(inspectPath, path, expected) {
  const current = inspectPath(path);
  if (expected === null) return current.status === 'absent';
  return current.status === 'present' && samePathIdentity(expected, current.identity);
}

function emptyDirectory(inspectPath, path) {
  const entries = [];
  const scan = streamDirectoryEntries(path, 1, (entry) => entries.push(entry.name));
  return scan.complete && entries.length === 0;
}

// The callback is deliberately checked after the test pause and immediately
// before the filesystem operation. A lease can expire while a reconciler is
// paused, and a replacement owner may then reuse the stage pathname.
function mutateStage(cfg, assertCapacityLease, validate, mutation) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!validate()) return false;
    cfg.testInterlock?.(STAGE_INTERLOCK, 'before', 'marker-capacity-stage-reconcile',
      'marker-capacity-stage-legacy');
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
  capacityTransactionPath, capacityStagePath, assertCapacityLease }) {
  const transactionPath = capacityTransactionPath(markerDir);
  const stagePath = capacityStagePath(markerDir);
  const stage = inspectPath(stagePath);
  if (stage.status === 'absent') return true;
  if (stage.status !== 'present' || !stage.identity?.isDirectory) return false;
  const entries = [];
  if (!streamDirectoryEntries(stagePath, 2, (entry) => entries.push(entry.name)).complete) return false;
  if (entries.length === 0) {
    return mutateStage(cfg, assertCapacityLease,
      () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
        && emptyDirectory(inspectPath, stagePath),
      () => rmdirSync(stagePath));
  }
  if (entries.length !== 1 || entries[0] !== 'transaction.json') return false;
  const stagedState = inspectPath(join(stagePath, 'transaction.json'), { content: true });
  if (stagedState.status !== 'present' || !stagedState.identity?.isFile
      || !parseTransactionState(stagedState.content)) return false;
  const currentStage = inspectPath(stagePath);
  if (currentStage.status !== 'present' || !samePathIdentity(stage.identity, currentStage.identity)) return false;
  const current = inspectPath(transactionPath);
  if (current.status === 'indeterminate') return false;
  const transactionIdentity = current.status === 'present' ? current.identity : null;
  if (current.status === 'absent') {
    return mutateStage(cfg, assertCapacityLease,
      () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
        && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
      () => renameSync(stagePath, transactionPath));
  }
  if (!mutateStage(cfg, assertCapacityLease,
    () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
      && sameStatusIdentity(inspectPath, join(stagePath, 'transaction.json'), stagedState.identity)
      && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
    () => unlinkSync(join(stagePath, 'transaction.json')))) return false;
  return mutateStage(cfg, assertCapacityLease,
    () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
      && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity)
      && emptyDirectory(inspectPath, stagePath),
    () => rmdirSync(stagePath));
}

// Compatibility for UUID stage siblings made by older releases. This pass is
// bounded because it is migration support only; fresh work never adds names
// to the shared parent.
function reconcileLegacyCapacityStages(markerDir, cfg, { inspectPath, parseTransactionState,
  capacityTransactionPath, assertCapacityLease }) {
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
      if (!mutateStage(cfg, assertCapacityLease,
        () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
          && emptyDirectory(inspectPath, stagePath),
        () => rmdirSync(stagePath))) indeterminate = true;
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
    const transactionIdentity = current.status === 'present' ? current.identity : null;
    if (current.status === 'absent') {
      if (!mutateStage(cfg, assertCapacityLease,
        () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
          && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
        () => renameSync(stagePath, transactionPath))) indeterminate = true;
      return;
    }
    if (!mutateStage(cfg, assertCapacityLease,
      () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
        && sameStatusIdentity(inspectPath, join(stagePath, 'transaction.json'), stagedState.identity)
        && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity),
      () => unlinkSync(join(stagePath, 'transaction.json')))) {
      indeterminate = true;
      return;
    }
    if (!mutateStage(cfg, assertCapacityLease,
      () => sameStatusIdentity(inspectPath, stagePath, stage.identity)
        && sameStatusIdentity(inspectPath, transactionPath, transactionIdentity)
        && emptyDirectory(inspectPath, stagePath),
      () => rmdirSync(stagePath))) indeterminate = true;
  });
  return !indeterminate;
}
