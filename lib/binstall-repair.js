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
    && current.contentBytes === prior.contentBytes
    && sameRequiredMode(
      current.expectedDestination?.identity?.mode,
      prior.expectedDestination?.identity?.mode,
    );
}

function sameTargetState(current, payload, requiredMode) {
  return current?.present === true
    && current.contentDigest === contentDigest(payload)
    && current.contentBytes === payload.byteLength
    && sameRequiredMode(current.expectedDestination?.identity?.mode, requiredMode);
}

function sameRequiredMode(actual, required) {
  // Windows does not preserve POSIX permission bits for these mirrored files;
  // content and regular-file identity remain the authoritative postconditions.
  if (process.platform === 'win32') return true;
  if (actual === undefined || actual === null || required === undefined || required === null) {
    return actual === required;
  }
  const actualBits = typeof actual === 'bigint' ? Number(actual & 0o7777n) : Number(actual) & 0o7777;
  const requiredBits = typeof required === 'bigint'
    ? Number(required & 0o7777n) : Number(required) & 0o7777;
  return actualBits === requiredBits;
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
  // Decide the complete removal set before touching any leaf. The fixed point
  // includes importers whose dependency was selected for removal, so an
  // importer can never be left runnable against a dependency that this pass
  // removes later.
  const disabled = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of publicationFiles) {
      const dependencies = dependencyGraph.get(file.dest) || new Set();
      const cannotRun = states.get(file.dest) !== 'target'
        || [...dependencies].some((dependency) => states.get(dependency) !== 'target'
          || disabled.has(dependency));
      const blockedByForeignBoundary = states.get(file.dest) === 'ready'
        && [...dependencies].includes('package.json')
        && states.get('package.json') === 'unproved'
        && foreignBoundaryIsNonRunnable(current.get('package.json'));
      if (cannotRun && !disabled.has(file.dest) && !blockedByForeignBoundary
          && (file.dest.startsWith('bin/') || dependencies.size > 0)) {
        disabled.add(file.dest);
        changed = true;
      }
    }
  }
  // Preflight every selected leaf before the first removal. An importer that
  // is not proven removable (foreign successor, unreadable state, etc.)
  // protects its entire dependency closure. The reverse publication order is
  // the reverse topological order, so a crash after an importer disappears
  // cannot strand that importer above a removed dependency.
  const preflight = new Map();
  const protectedBy = new Map();
  const protectClosure = (dest) => {
    const pending = [...(dependencyGraph.get(dest) || [])];
    const visited = new Set();
    while (pending.length > 0) {
      const dependency = pending.shift();
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      if (!protectedBy.has(dependency)) protectedBy.set(dependency, new Set());
      protectedBy.get(dependency).add(dest);
      for (const transitive of dependencyGraph.get(dependency) || []) pending.push(transitive);
    }
  };
  const reportDisableFailure = (item, reason, error = null) => {
    const detail = {
      dest: item.file.dest,
      path: toBinRelative(binDir, item.path),
      reason,
    };
    const code = error?.code || error?.name
      || (reason === 'foreign-successor' ? null : 'DISABLE_FAILED');
    if (code) detail.code = code;
    report.disableFailures.push(detail);
    protectClosure(item.file.dest);
  };

  for (const file of publicationFiles) {
    if (!disabled.has(file.dest)) continue;
    const item = items.get(file.dest);
    let before;
    try {
      before = captureRegularFileSnapshot(item.path);
    } catch (error) {
      reportDisableFailure(item, 'inspection-failed', error);
      preflight.set(file.dest, { failed: true });
      continue;
    }
    if (!before.present) {
      preflight.set(file.dest, { absent: true });
      continue;
    }
    if (classifyContent(before.present, before.content, SetForBin) === Ownership.foreign) {
      reportDisableFailure(item, 'foreign-successor');
      preflight.set(file.dest, { failed: true });
      continue;
    }
    preflight.set(file.dest, { before });
  }

  for (const file of [...publicationFiles].reverse()) {
    if (!disabled.has(file.dest)) continue;
    const item = items.get(file.dest);
    const planned = preflight.get(file.dest);
    if (planned?.failed) continue;
    if (planned?.absent) {
      states.set(file.dest, 'disabled');
      continue;
    }
    if (protectedBy.has(file.dest)) {
      report.protected.push({
        dest: file.dest,
        path: toBinRelative(binDir, item.path),
        reason: 'surviving-dependent',
        requiredBy: [...protectedBy.get(file.dest)].sort(),
      });
      if (file.dest.startsWith('lib/')) {
        report.protectedDependencies.push(report.protected.at(-1));
      }
      continue;
    }

    const before = planned.before;
    try {
      options.testInterlock?.('binstall-before-disable', item.file.dest);
      helpers.requireLease(lease, binDir);
      removeOwnedRegularFile(item.path, before.expectedDestination, {
        assertOwnership: () => helpers.assertOwnership(lease, binDir),
        lifecycleLease: lease,
        testInterlock: options.testInterlock,
      });
      const after = captureRegularFileSnapshot(item.path);
      if (!after.present) {
        states.set(file.dest, 'disabled');
        report.disabled.push(toBinRelative(binDir, item.path));
      } else {
        reportDisableFailure(item, 'successor-preserved');
        states.set(file.dest, 'failed');
      }
    } catch (error) {
      if (error?.leaseLost) throw error;
      reportDisableFailure(item, 'disable-failed', error);
      states.set(file.dest, 'failed');
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
    if (sameTargetState(snapshot, generation.payloads.get(file.dest), item.file.mode)) {
      states.set(file.dest, 'target');
    }
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
      if (!sameTargetState(after, payload, item.file.mode)) {
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
