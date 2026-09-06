import { captureRegularFileSnapshot, removeOwnedRegularFile, writeFileAtomic } from './fsutil.js';
import { SetForBin, classifyContent, Ownership } from './sentinel.js';
import { contentDigest } from './fs-atomic-identity.js';
import { join, relative, sep } from 'node:path';

function toBinRelative(binDir, path) {
  return relative(binDir, path).split(sep).join('/');
}

export function sameRollbackState(current, prior) {
  if (!current.present || !prior.present) return current.present === prior.present;
  return current.contentDigest === prior.contentDigest
    && current.contentBytes === prior.contentBytes;
}

function sameTargetState(current, payload) {
  return current?.present === true
    && current.contentDigest === contentDigest(payload)
    && current.contentBytes === payload.byteLength;
}

function connectedRuntimeComponent(start, dependencyGraph) {
  const reverse = new Map();
  for (const [importer, dependencies] of dependencyGraph) {
    for (const dependency of dependencies) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(importer);
    }
  }
  const component = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const neighbor of [
      ...(dependencyGraph.get(current) || []), ...(reverse.get(current) || []),
    ]) {
      if (component.has(neighbor)) continue;
      component.add(neighbor);
      pending.push(neighbor);
    }
  }
  return component;
}

function recordRepublishFailure(report, item, binDir, error, reason) {
  const detail = {
    dest: item.file.dest,
    path: toBinRelative(binDir, item.path),
    action: 'republish',
    reason,
    code: error?.code || error?.name || 'REPUBLISH_FAILED',
  };
  report.failed.push(detail);
  report.republishFailures.push(detail);
  if (item.file.dest.startsWith('bin/')) report.failedExecutables.push(detail);
}

function foreignBoundaryIsNonRunnable(snapshot) {
  if (!snapshot?.present) return false;
  try {
    return JSON.parse(snapshot.content.toString('utf8')).type !== 'module';
  } catch {
    return true;
  }
}

function disableUnconvergedImporters(
  publicationFiles, items, states, dependencyGraph, current, lease, binDir, report, options, helpers,
) {
  const disabled = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of publicationFiles) {
      const dependencies = dependencyGraph.get(file.dest) || [];
      const cannotRun = states.get(file.dest) !== 'target'
        || [...dependencies].some((dependency) => states.get(dependency) !== 'target'
          || disabled.has(dependency));
      const blockedByForeignBoundary = states.get(file.dest) === 'ready'
        && [...dependencies].includes('package.json')
        && states.get('package.json') === 'unproved'
        && foreignBoundaryIsNonRunnable(current.get('package.json'));
      if (cannotRun && !disabled.has(file.dest) && !blockedByForeignBoundary
          && (file.dest.startsWith('bin/') || dependencies.length > 0)) {
        disabled.add(file.dest);
        changed = true;
      }
    }
  }

  for (const file of publicationFiles) {
    if (!disabled.has(file.dest)) continue;
    const item = items.get(file.dest);
    let before;
    try {
      before = captureRegularFileSnapshot(item.path);
    } catch (error) {
      report.disableFailures.push({
        dest: file.dest, path: toBinRelative(binDir, item.path),
        reason: 'inspection-failed', code: error?.code || error?.name || 'INSPECTION_FAILED',
      });
      continue;
    }
    if (!before.present) {
      states.set(file.dest, 'disabled');
      continue;
    }
    if (classifyContent(before.present, before.content, SetForBin) === Ownership.foreign) {
      report.disableFailures.push({
        dest: file.dest, path: toBinRelative(binDir, item.path), reason: 'foreign-successor',
      });
      continue;
    }
    try {
      helpers.requireLease(lease, binDir);
      const result = removeOwnedRegularFile(item.path, before.expectedDestination, {
        assertOwnership: () => helpers.assertOwnership(lease, binDir),
        lifecycleLease: lease,
        testInterlock: options.testInterlock,
      });
      const after = captureRegularFileSnapshot(item.path);
      if (result === true || !after.present) {
        states.set(file.dest, 'disabled');
        report.disabled.push(toBinRelative(binDir, item.path));
      } else {
        report.disableFailures.push({
          dest: file.dest, path: toBinRelative(binDir, item.path), reason: 'successor-preserved',
        });
      }
    } catch (error) {
      if (error?.leaseLost) throw error;
      report.disableFailures.push({
        dest: file.dest, path: toBinRelative(binDir, item.path),
        reason: 'disable-failed', code: error?.code || error?.name || 'DISABLE_FAILED',
      });
    }
  }
}

export function republishConnectedGeneration(
  failedDest, published, snapshots, generation, lease, binDir, dependencyGraph, report, options, helpers,
) {
  const component = connectedRuntimeComponent(failedDest, dependencyGraph);
  const publishedByDest = new Map(published.map((item) => [item.file.dest, item]));
  const publicationFiles = generation.publicationFiles.filter((file) => component.has(file.dest));
  const items = new Map();
  for (const file of publicationFiles) {
    items.set(file.dest, publishedByDest.get(file.dest) || {
      file, path: join(binDir, file.dest), prior: snapshots.get(file.dest), publication: null,
    });
  }

  // Establish every member before the first write. A foreign boundary or
  // shared dependency therefore blocks the whole frozen runtime generation.
  const states = new Map();
  const current = new Map();
  const unproved = [];
  for (const file of publicationFiles) {
    const item = items.get(file.dest);
    if (!generation.payloads.has(file.dest)) {
      unproved.push({ item, reason: 'source-unavailable' });
      continue;
    }
    let snapshot;
    try {
      snapshot = captureRegularFileSnapshot(item.path);
    } catch (error) {
      unproved.push({ item, reason: 'inspection-failed', error });
      continue;
    }
    current.set(file.dest, snapshot);
    if (sameTargetState(snapshot, generation.payloads.get(file.dest))) states.set(file.dest, 'target');
    else if (sameRollbackState(snapshot, item.prior)) states.set(file.dest, 'ready');
    else unproved.push({ item, reason: 'unproved-target' });
  }
  for (const entry of unproved) {
    const { item, reason, error } = entry;
    const detail = {
      dest: item.file.dest, path: toBinRelative(binDir, item.path), reason,
      code: error?.code || error?.name || 'UNPROVED_TARGET',
    };
    report.preflight.push(detail);
    states.set(item.file.dest, 'unproved');
    if (!report.failed.some((failure) => failure.dest === detail.dest && failure.reason === detail.reason)) {
      recordRepublishFailure(report, item, binDir, error, reason);
    }
  }

  // Repeated dependency-order passes converge a repair after a post-rename
  // error while keeping a permanently unrepairable leaf from starving importers.
  const maxPasses = publicationFiles.length + 1;
  const attempts = new Map();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let progress = false;
    for (const file of publicationFiles) {
      const item = items.get(file.dest);
      const state = states.get(file.dest);
      if (state === 'target' || state === 'unproved') continue;
      const dependency = [...(dependencyGraph.get(file.dest) || [])]
        .find((dest) => states.get(dest) !== 'target');
      if (dependency || (attempts.get(file.dest) || 0) >= 2) continue;
      const before = current.get(file.dest);
      if (!before?.present) {
        states.set(file.dest, 'failed');
        continue;
      }
      attempts.set(file.dest, (attempts.get(file.dest) || 0) + 1);
      const payload = generation.payloads.get(file.dest);
      let actionError = null;
      try {
        options.testInterlock?.('binstall-before-rollback-republish', item.file.dest);
        helpers.requireLease(lease, binDir);
        writeFileAtomic(item.path, payload, {
          mode: item.file.mode,
          expectedDestination: before.expectedDestination,
          assertOwnership: () => helpers.assertOwnership(lease, binDir),
          lifecycleLease: lease,
          testInterlock: options.testInterlock,
        });
      } catch (error) {
        if (error?.leaseLost) throw error;
        helpers.requireLease(lease, binDir);
        actionError = error;
      }
      let after;
      try {
        after = captureRegularFileSnapshot(item.path);
      } catch (error) {
        states.set(file.dest, 'failed');
        recordRepublishFailure(report, item, binDir, error, 'inspection-failed');
        progress = true;
        continue;
      }
      current.set(file.dest, after);
      if (!sameTargetState(after, payload)) {
        states.set(file.dest, 'failed');
        recordRepublishFailure(report, item, binDir, actionError, 'republish-failed');
        if (after.present && !sameRollbackState(after, item.prior)) {
          helpers.recordRollbackSurvivor(report, item, binDir, 'republish-failed');
        }
        progress = true;
        continue;
      }
      states.set(file.dest, 'target');
      report.republished.push(toBinRelative(binDir, item.path));
      progress = true;
    }
    if (!progress) break;
  }

  disableUnconvergedImporters(
    publicationFiles, items, states, dependencyGraph, current, lease, binDir, report, options, helpers,
  );
}
