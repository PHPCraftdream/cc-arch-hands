import { lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SetForBin, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, removeOwnedRegularFile, sameFileIdentity,
  stablePathExists, writeFileAtomic, maintainRecoveryArtifacts,
  mergeMaintenanceReport, isQuarantineName, emptyMaintenanceReport,
} from './fsutil.js';
import { acquireLease, LEASE_MAX_MS, releaseLease, renewLease } from './lease-lock.js';
import {
  BinFileDefinitions, companionImportGraph, deriveCompanionPublicationOrder,
  validateCompanionFileOrder, freezeCompanionGeneration,
} from './binstall/runtime.js';
import { republishConnectedGeneration, sameRollbackState } from './binstall-repair.js';

// Keep the operation fence beside, rather than inside, the removable runtime
// tree.  A failed uninstall therefore cannot remove the lock that is needed
// to recover that uninstall, and install/uninstall always rendezvous on the
// same stable path.
const BIN_LIFECYCLE_LOCK_SUFFIX = '.lock';
const BIN_LIFECYCLE_KIND = 'cc-arch-hands-bin-lifecycle';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function binLifecycleLockPath(binDir) {
  return `${binDir}${BIN_LIFECYCLE_LOCK_SUFFIX}`;
}

export class BinLifecycleBusyError extends Error {
  constructor(binDir) {
    super(`companion bins are busy: another install or uninstall is in progress (${binDir})`);
    this.name = 'BinLifecycleBusyError';
    this.path = binLifecycleLockPath(binDir);
  }
}

export class BinLifecycleLeaseLostError extends Error {
  constructor(binDir) {
    super(`companion bins lease lost; aborting without rollback or pruning (${binDir})`);
    this.name = 'BinLifecycleLeaseLostError';
    this.code = 'ERR_BIN_LIFECYCLE_LEASE_LOST';
    this.path = binLifecycleLockPath(binDir);
    this.leaseLost = true;
  }
}

function withBinLifecycleLease(binDir, operation, options = {}) {
  const lease = acquireLease(binLifecycleLockPath(binDir), {
    kind: BIN_LIFECYCLE_KIND,
    // Match the shared lease policy: an ownerless claim is stale only after
    // five minutes, while a dead owner can be reclaimed immediately and a
    // live owner is reclaimed only once its current heartbeat has expired.
    staleAfterMs: LEASE_MAX_MS,
    testLeaseEnv: 'CAH_TEST_ONLY_BIN_LEASE_MS',
    fenceSuffix: '.stale-',
    interlockPhase: 'binstall-lease-reclaim',
    releaseInterlockPhase: 'binstall-lease-release',
    testInterlock: options.testInterlock,
  });
  if (!lease) throw new BinLifecycleBusyError(binDir);
  try {
    // This pause is test-only and occurs after ownership is published but
    // before preflight, making contention tests deterministic while keeping
    // the entire lifecycle under the same lease.
    options.testInterlock?.('binstall-after-lease');
    return operation(lease);
  } finally {
    releaseLease(lease);
  }
}

export function getBinFileImportGraph(files = BinFiles, sourceRoot = PACKAGE_ROOT, sourceBytes = null) {
  return companionImportGraph(files, sourceRoot, sourceBytes);
}

export function deriveBinFilePublicationOrder(files = BinFiles, sourceRoot = PACKAGE_ROOT) {
  return deriveCompanionPublicationOrder(files, sourceRoot);
}

export function validateBinFileOrder(files = BinFiles, sourceRoot = PACKAGE_ROOT) {
  return validateCompanionFileOrder(files, sourceRoot);
}

export const BinFiles = Object.freeze(deriveCompanionPublicationOrder(BinFileDefinitions));
validateBinFileOrder(BinFiles);

const BoundaryFile = BinFiles.find((file) => file.dest === 'package.json');

// Runtime state kept alongside the managed companion-bin tree. These entries
// belong to the bin root's namespace but are not owned by the installer, so
// root sweeps must leave them alone without reporting them as foreign.
const ReservedRootEntries = new Set(['cache']);

// Subdirectories we own under the bin root, plus the set of leaf names we write
// into each. Used to prune orphans (renamed/removed bins) without touching
// foreign files.
const OwnedDirs = {
  // The mirrored subdirectories are structural children of the root, not
  // orphan leaf candidates for the root sweep itself.
  '': new Set([
    ...BinFiles.filter((f) => !f.dest.includes('/')).map((f) => leaf(f.dest)),
    'bin',
    'lib',
    ...ReservedRootEntries,
  ]),
  bin: new Set(BinFiles.filter((f) => f.dest.startsWith('bin/')).map((f) => leaf(f.dest))),
  lib: new Set(BinFiles.filter((f) => f.dest.startsWith('lib/')).map((f) => leaf(f.dest))),
};

function leaf(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

export function writeBins(binDir, sourceRoot, options = {}) {
  if (!binDir) throw new Error('writeBins: nil binDir');
  if (!sourceRoot) throw new Error('writeBins: nil sourceRoot');

  // Capture the complete attempted generation before acquiring the lifecycle
  // lease itself can create or reclaim filesystem state.
  const generation = freezeCompanionGeneration(BinFiles, sourceRoot, {
    testInterlock: options.testInterlock,
  });
  return withBinLifecycleLease(
    binDir,
    (lease) => writeBinsUnlocked(binDir, generation, lease, options),
    options,
  );
}

function requireBinLifecycleLease(lease, binDir) {
  if (!renewLease(lease)) throw new BinLifecycleLeaseLostError(binDir);
}

function writeBinsUnlocked(binDir, generation, lease, options = {}) {

  // The hook is intentionally after the freeze so tests and callers can prove
  // that a source swap cannot alter the in-flight generation.
  options.testInterlock?.('binstall-after-source-freeze');

  // The companion bins are one runtime closure, not independent optional
  // files. Capture every declared destination before creating a directory or
  // publishing any leaf. A foreign dependency or executable would otherwise
  // leave a mixed runtime that can fail only after install has reported
  // success, so all foreign declared leaves are an explicit zero-mutation
  // failure. Unknown extra files remain outside this closure and are still
  // preserved and reported by the orphan sweep below.
  const snapshots = preflightBinLeaves(binDir);
  const { publicationFiles, graph: dependencyGraph, payloads } = generation;
  const boundary = {
    path: join(binDir, BoundaryFile.dest),
    snapshot: snapshots.get(BoundaryFile.dest),
  };

  let written = 0;
  const skipped = [];
  const recovery = [];
  const maintenance = emptyMaintenanceReport();
  const published = [];

  try {
    // Publish the boundary before any bin/lib leaf. Its conditional expected
    // destination is the exact preflight identity, so a concurrent creator or
    // replacer cannot be overwritten.
    requireBinLifecycleLease(lease, binDir);
    let boundaryPublication;
    try {
      boundaryPublication = publishBinFile(
        binDir, BoundaryFile, boundary.snapshot, payloads.get(BoundaryFile.dest),
        () => requireBinLifecycleLease(lease, binDir), lease,
      );
    } catch (error) {
      enrollCommittedPublication(
        published, BoundaryFile, boundary.path, boundary.snapshot, error,
      );
      throw error;
    }
    published.push({
      file: BoundaryFile,
      path: join(binDir, BoundaryFile.dest),
      prior: boundary.snapshot,
      publication: boundaryPublication,
    });
    written++;

    // Test-only pause used to replace the boundary immediately after its
    // publication. The subsequent exact check must fail before leaves can be
    // reported as a successful install.
    options.testInterlock?.('binstall-after-boundary');

    let publishedLeaves = 0;
    let executablePhaseStarted = false;
    for (const f of publicationFiles) {
      if (f === BoundaryFile) continue;
      requireBinLifecycleLease(lease, binDir);
      assertPublishedBoundary(boundary.path, boundaryPublication);

      // All shared imports have been published before the first executable is
      // published. This interlock also gives tests a stable staged-tree
      // boundary to smoke.
      if (!executablePhaseStarted && f.dest.startsWith('bin/')) {
        options.testInterlock?.('binstall-after-dependencies');
        requireBinLifecycleLease(lease, binDir);
        executablePhaseStarted = true;
      }

      const destPath = join(binDir, f.dest);
      const snapshot = snapshots.get(f.dest);
      options.testInterlock?.('binstall-before-leaf-write', f.dest);
      const payload = payloads.get(f.dest);
      requireBinLifecycleLease(lease, binDir);
      mkdirSync(dirname(destPath), { recursive: true });
      requireBinLifecycleLease(lease, binDir);
      let publication;
      try {
        publication = writeFileAtomic(destPath, payload, {
          mode: f.mode,
          expectedDestination: snapshot.expectedDestination,
          assertOwnership: () => requireBinLifecycleLease(lease, binDir),
          lifecycleLease: lease,
          testInterlock: options.testInterlock,
        });
      } catch (error) {
        enrollCommittedPublication(published, f, destPath, snapshot, error);
        throw error;
      }
      published.push({ file: f, path: destPath, prior: snapshot, publication });
      written++;
      publishedLeaves++;
      if (publishedLeaves === 1) options.testInterlock?.('binstall-after-first-leaf');
    }

    requireBinLifecycleLease(lease, binDir);
    assertPublishedBoundary(boundary.path, boundaryPublication);

    requireBinLifecycleLease(lease, binDir);
    mergeCacheMaintenance(
      binDir, recovery, maintenance, () => requireBinLifecycleLease(lease, binDir), lease,
    );

    let pruned = 0;
    for (const [sub, known] of Object.entries(OwnedDirs)) {
      const dir = sub ? join(binDir, sub) : binDir;
      requireBinLifecycleLease(lease, binDir);
      const orphanReport = pruneOrphans(dir, known, SetForBin, {
        beforeRemove: () => requireBinLifecycleLease(lease, binDir),
        assertOwnership: () => requireBinLifecycleLease(lease, binDir),
        recovery: { lifecycleLease: lease },
        testInterlock: options.testInterlock,
      });
      pruned += orphanReport.pruned;
      mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
    }

    // Pruning is also part of the install transaction: do not claim success if
    // the runtime boundary was replaced while it was in progress.
    requireBinLifecycleLease(lease, binDir);
    assertPublishedBoundary(boundary.path, boundaryPublication);
    return { written, skipped, recovery, maintenance, pruned };
  } catch (error) {
    if (error?.leaseLost) throw error;
    // Once the lease is gone, the path may belong to a complete successor
    // install. Never inspect it for rollback ownership or prune it further.
    requireBinLifecycleLease(lease, binDir);
    const rollback = rollbackPublishedLeaves(
      published, snapshots, generation, lease, binDir, dependencyGraph, options,
    );
    if (rollback.incomplete) attachRollbackRecovery(error, rollback);
    throw error;
  }
}

function preflightBinLeaves(binDir) {
  const snapshots = new Map();
  for (const file of BinFiles) {
    const path = join(binDir, file.dest);
    const leafStat = lstatNoFollow(path);
    if (leafStat !== null && (!leafStat.isFile() || leafStat.nlink > 1n)) {
      throwForeignLeaf(file, path, leafStat);
    }
    const snapshot = captureRegularFileSnapshot(path);
    snapshots.set(file.dest, snapshot);
    if (!snapshot.present || classifyContent(snapshot.present, snapshot.content, SetForBin)
      !== Ownership.foreign) continue;

    if (file === BoundaryFile) {
      throw new Error(
        `foreign package boundary at ${path}: managed companion bins require the cah-owned ESM package.json`,
      );
    }
    throw new Error(
      `foreign managed runtime leaf at ${path}: refusing a mixed companion-bin closure`,
    );
  }
  return snapshots;
}

function findOpaqueBinEntries(binDir) {
  const dir = join(binDir, 'bin');
  const known = new Set(BinFiles
    .filter((file) => file.dest.startsWith('bin/'))
    .map((file) => leaf(file.dest)));
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const opaque = [];
  for (const entry of entries) {
    if (known.has(entry.name) || isQuarantineName(entry.name)) continue;
    const path = join(dir, entry.name);
    const stat = lstatNoFollow(path);
    if (stat === null || !stat.isFile()) {
      opaque.push(path);
      continue;
    }
    try {
      const snapshot = captureRegularFileSnapshot(path);
      if (snapshot.present
          && classifyContent(snapshot.present, snapshot.content, SetForBin) === Ownership.foreign) {
        opaque.push(path);
      }
    } catch {
      opaque.push(path);
    }
  }
  return opaque;
}

function findForeignRuntimeEntries(binDir) {
  const entries = [];
  for (const [sub, known] of Object.entries(OwnedDirs)) {
    const dir = sub ? join(binDir, sub) : binDir;
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const child of children) {
      if (known.has(child.name) || isQuarantineName(child.name)) continue;
      const path = join(dir, child.name);
      const stat = lstatNoFollow(path);
      if (stat === null || !stat.isFile()) {
        entries.push(path);
        continue;
      }
      try {
        const snapshot = captureRegularFileSnapshot(path);
        if (snapshot.present
            && classifyContent(snapshot.present, snapshot.content, SetForBin) === Ownership.foreign) {
          entries.push(path);
        }
      } catch {
        entries.push(path);
      }
    }
  }
  return entries;
}

function installedBinImportGraph(snapshots) {
  // Uninstall must describe the runtime that is on disk. Reading sourceRoot
  // here lets a source edit erase a dependency needed by a surviving binary.
  const sourceBytes = new Map(BinFiles.map((file) => [
    file.dest,
    snapshots.get(file.dest)?.present ? snapshots.get(file.dest).content : Buffer.alloc(0),
  ]));
  try {
    return getBinFileImportGraph(BinFiles, PACKAGE_ROOT, sourceBytes);
  } catch {
    // A managed leaf with an opaque or malformed import list cannot be safely
    // narrowed. Every executable therefore depends on the full managed set.
    return conservativeBinImportGraph(snapshots);
  }
}

function conservativeBinImportGraph(snapshots) {
  const present = BinFiles
    .filter((file) => snapshots.get(file.dest)?.present)
    .map((file) => file.dest);
  const libraries = present.filter((dest) => dest.startsWith('lib/'));
  const graph = new Map();
  for (const file of BinFiles) {
    if (!snapshots.get(file.dest)?.present) {
      graph.set(file.dest, new Set());
      continue;
    }
    graph.set(file.dest, new Set(file.dest.startsWith('bin/')
      ? [...libraries, 'package.json'].filter((dest) => dest !== file.dest)
      : file.dest === 'package.json' ? [] : ['package.json']));
  }
  return graph;
}

function lstatNoFollow(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function throwForeignLeaf(file, path, stat) {
  const kind = stat.isSymbolicLink()
    ? 'symbolic link'
    : stat.isDirectory()
      ? 'directory'
      : stat.isFile() && stat.nlink > 1n
        ? 'multi-hardlink regular file'
        : 'non-regular entry';
  if (file === BoundaryFile) {
    throw new Error(
      `foreign package boundary at ${path}: ${kind}; managed companion bins require the cah-owned ESM package.json`,
    );
  }
  throw new Error(
    `foreign managed runtime leaf at ${path}: ${kind}; refusing a mixed companion-bin closure`,
  );
}

function publishBinFile(
  binDir, file, snapshot, payload, assertOwnershipCallback = null, lifecycleLease = null,
) {
  const destPath = join(binDir, file.dest);
  assertOwnershipCallback?.();
  mkdirSync(dirname(destPath), { recursive: true });
  assertOwnershipCallback?.();
  return writeFileAtomic(destPath, payload, {
    mode: file.mode,
    expectedDestination: snapshot.expectedDestination,
    assertOwnership: assertOwnershipCallback,
    lifecycleLease,
  });
}

function enrollCommittedPublication(published, file, path, prior, error) {
  const publication = error?.committedPublication;
  if (!publication?.present || publication.path !== path
      || published.some((item) => item.path === path)) return false;
  published.push({ file, path, prior, publication });
  return true;
}

function assertPublishedBoundary(path, publication) {
  const current = captureRegularFileSnapshot(path);
  if (!current.present
      || !sameFileIdentity(current.expectedDestination.identity, publication.identity)
      || current.contentDigest !== publication.contentDigest
      || current.contentBytes !== publication.contentBytes) {
    throw new Error(`managed package boundary changed concurrently at ${path}; refusing operation`);
  }
}

function rollbackPublishedLeaves(
  published, snapshots, generation, lease, binDir, dependencyGraph, options = {},
) {
  const report = {
    incomplete: false,
    failed: [],
    failedExecutables: [],
    survivors: [],
    protected: [],
    protectedDependencies: [],
    republished: [],
    republishFailures: [],
    disabled: [],
    disableFailures: [],
    preflight: [],
  };
  const protectedBy = new Map();
  const dependencyFailures = new Set();

  for (const item of [...published].reverse()) {
    requireBinLifecycleLease(lease, binDir);

    options.testInterlock?.('binstall-before-rollback', item.file.dest);
    const protectedReasons = protectedBy.get(item.file.dest);
    if (protectedReasons) {
      const detail = {
        dest: item.file.dest,
        path: toBinRelative(binDir, item.path),
        reason: 'surviving-dependent',
        requiredBy: [...protectedReasons].sort(),
      };
      report.protected.push(detail);
      if (item.file.dest.startsWith('lib/')) report.protectedDependencies.push(detail);
      continue;
    }

    let current;
    try {
      current = captureRegularFileSnapshot(item.path);
    } catch (error) {
      recordRollbackFailure(report, item, binDir, 'inspect', error, 'inspection-failed');
      protectDependencies(item.file.dest, dependencyGraph, protectedBy);
      noteDependencyRollbackFailure(item.file.dest, dependencyFailures);
      continue;
    }
    if (!current.present
        || !sameFileIdentity(current.expectedDestination.identity, item.publication.identity)
        || current.contentDigest !== item.publication.contentDigest
        || current.contentBytes !== item.publication.contentBytes) {
      // A successor now occupies the name. It is not ours to remove or
      // overwrite, even when the failed publication was ours.
      recordRollbackFailure(
        report, item, binDir, item.prior.present ? 'restore' : 'remove',
        null, 'surviving-successor',
      );
      recordRollbackSurvivor(report, item, binDir, 'surviving-successor');
      protectDependencies(item.file.dest, dependencyGraph, protectedBy);
      noteDependencyRollbackFailure(item.file.dest, dependencyFailures);
      continue;
    }

    const action = item.prior.present ? 'restore' : 'remove';
    let actionError = null;
    try {
      if (item.prior.present) {
        const priorMode = item.prior.expectedDestination.identity?.mode;
        const restoreMode = typeof priorMode === 'bigint'
          ? Number(priorMode & 0o7777n)
          : priorMode === undefined ? undefined : priorMode & 0o7777;
        requireBinLifecycleLease(lease, binDir);
        writeFileAtomic(item.path, item.prior.content, {
          mode: restoreMode,
          expectedDestination: item.publication.expectedDestination,
          assertOwnership: () => requireBinLifecycleLease(lease, binDir),
          lifecycleLease: lease,
          testInterlock: options.testInterlock,
          ...(item.file === BoundaryFile
            ? { testInterlockPhase: 'binstall-rollback-before-final' }
            : {}),
        });
      } else {
        requireBinLifecycleLease(lease, binDir);
        removeOwnedRegularFile(item.path, item.publication.expectedDestination, {
          assertOwnership: () => requireBinLifecycleLease(lease, binDir),
          lifecycleLease: lease,
          testInterlock: options.testInterlock,
        });
      }
    } catch (error) {
      if (error?.leaseLost) throw error;
      // A successor may have reclaimed the lease while an atomic rollback
      // helper was paused at its final publication boundary. Surface that
      // ownership loss instead of allowing the original error to disguise it.
      requireBinLifecycleLease(lease, binDir);
      actionError = error;
    }

    let after;
    let inspectionError = null;
    try {
      after = captureRegularFileSnapshot(item.path);
    } catch (error) {
      inspectionError = error;
    }
    if (inspectionError) {
      recordRollbackFailure(report, item, binDir, action, inspectionError, 'inspection-failed');
      protectDependencies(item.file.dest, dependencyGraph, protectedBy);
      noteDependencyRollbackFailure(item.file.dest, dependencyFailures);
      continue;
    }

    const reachedPrior = sameRollbackState(after, item.prior);
    if (actionError) {
      recordRollbackFailure(report, item, binDir, action, actionError,
        reachedPrior ? 'state-reached-with-error' : 'rollback-failed');
    }
    if (reachedPrior) continue;

    const reason = after.present ? 'surviving-successor' : 'rollback-failed';
    if (!actionError) recordRollbackFailure(report, item, binDir, action, null, reason);
    recordRollbackSurvivor(report, item, binDir, reason);
    protectDependencies(item.file.dest, dependencyGraph, protectedBy);
    noteDependencyRollbackFailure(item.file.dest, dependencyFailures);
  }

  for (const dest of dependencyFailures) {
    republishConnectedGeneration(
      dest, published, snapshots, generation, lease, binDir, dependencyGraph, report, options, {
        requireLease: requireBinLifecycleLease,
        assertOwnership: requireBinLifecycleLease,
        recordRollbackSurvivor,
      },
    );
  }
  report.incomplete = report.failed.length > 0 || report.protected.length > 0
    || report.disableFailures.length > 0;
  return report;
}

function noteDependencyRollbackFailure(dest, failures) {
  // An importer that failed to roll back can itself be the mixed leaf (for
  // example an executable restored against an older library). Repair its
  // connected closure too; the convergence pass will leave unrelated
  // components untouched.
  failures.add(dest);
}

function recordRollbackFailure(report, item, binDir, action, error, reason) {
  const detail = {
    dest: item.file.dest,
    path: toBinRelative(binDir, item.path),
    action,
    reason,
    code: error?.code || error?.name || 'ROLLBACK_FAILED',
  };
  report.failed.push(detail);
  if (item.file.dest.startsWith('bin/')) report.failedExecutables.push(detail);
}

function recordRollbackSurvivor(report, item, binDir, reason) {
  report.survivors.push({
    dest: item.file.dest,
    path: toBinRelative(binDir, item.path),
    reason,
  });
}

function protectDependencies(dest, dependencyGraph, protectedBy) {
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
}

function protectOpaqueRuntime(snapshots, protectedBy, importer) {
  for (const file of BinFiles) {
    if (!snapshots.get(file.dest)?.present) continue;
    if (!protectedBy.has(file.dest)) protectedBy.set(file.dest, new Set());
    protectedBy.get(file.dest).add(importer);
  }
}

function hasOpaqueSuccessor(path, prior) {
  let current;
  try {
    current = captureRegularFileSnapshot(path);
  } catch {
    return true;
  }
  if (!current.present) return false;
  return !sameFileIdentity(current.expectedDestination.identity, prior.expectedDestination.identity)
    || current.contentDigest !== prior.contentDigest
    || current.contentBytes !== prior.contentBytes;
}

function protectSurvivingLeaf(
  file, path, snapshot, snapshots, dependencyGraph, protectedBy, skipped, binDir, state,
) {
  if (!stablePathExists(path)) return;
  addUnique(skipped, toBinRelative(binDir, path));
  const isOpaqueImporter = file.dest.endsWith('.js')
    && (file.dest.startsWith('bin/') || file.dest.startsWith('lib/'));
  if (isOpaqueImporter && hasOpaqueSuccessor(path, snapshot)) {
    // A foreign executable or library is an opaque importer. Its imports
    // cannot be inferred, so preserve every remaining managed leaf.
    state.opaqueImporter = true;
    protectOpaqueRuntime(snapshots, protectedBy, file.dest);
    return;
  }
  // A managed successor with the same exact payload is still described by
  // the installed preflight graph, never by the current package source.
  protectDependencies(file.dest, dependencyGraph, protectedBy);
}

function attachRollbackRecovery(error, report) {
  error.rollback = report;
  error.recovery = report;
  error.rollbackIncomplete = true;
  const failed = report.failed.map((entry) => `${entry.dest} (${entry.reason})`);
  const disableFailures = report.disableFailures
    .map((entry) => `${entry.dest} (${entry.reason})`);
  const protectedPaths = report.protected.map((entry) => entry.dest);
  const details = [
    ...failed,
    ...disableFailures,
    ...protectedPaths.map((dest) => `${dest} (protected)`),
  ];
  error.message += `; incomplete rollback recovery: ${details.join(', ')}`;
}

export function removeBins(binDir, _sourceRoot = undefined, maybeOptions = undefined) {
  if (!binDir) throw new Error('removeBins: nil binDir');
  const options = maybeOptions || (_sourceRoot && typeof _sourceRoot === 'object' ? _sourceRoot : {});

  return withBinLifecycleLease(
    binDir, (lease) => removeBinsUnlocked(binDir, lease, options), options,
  );
}

function removeBinsUnlocked(binDir, lease, options = {}) {

  // Match install's closure rule: a foreign declared runtime leaf makes the
  // operation fail before the first removal. This prevents uninstall from
  // silently deleting the rest of a runtime it no longer owns.
  const snapshots = preflightBinLeaves(binDir);
  const dependencyGraph = installedBinImportGraph(snapshots);
  const opaqueBinEntries = findOpaqueBinEntries(binDir);
  const protectedBy = new Map();
  const state = { opaqueImporter: opaqueBinEntries.length > 0 };
  let removed = 0;
  const skipped = [];
  const recovery = [];
  const maintenance = emptyMaintenanceReport();

  for (const path of opaqueBinEntries) {
    addUnique(skipped, toBinRelative(binDir, path));
    protectOpaqueRuntime(snapshots, protectedBy, toBinRelative(binDir, path));
  }
  if (state.opaqueImporter) {
    for (const path of findForeignRuntimeEntries(binDir)) {
      addUnique(skipped, toBinRelative(binDir, path));
    }
  }

  requireBinLifecycleLease(lease, binDir);
  mergeCacheMaintenance(
    binDir, recovery, maintenance, () => requireBinLifecycleLease(lease, binDir), lease,
  );

  // BinFiles is published from the low-level dependency boundary towards the
  // executables. Its reverse is therefore the strict teardown order: every
  // executable, then dependent/shared libraries, then low-level libraries,
  // and the Node 18 ESM package boundary last.
  for (const file of [...BinFiles].reverse()) {
    if (file === BoundaryFile) continue;
    const snapshot = snapshots.get(file.dest);
    if (!snapshot.present) continue;
    const path = join(binDir, file.dest);
    if (protectedBy.has(file.dest)) {
      addUnique(skipped, toBinRelative(binDir, path));
      continue;
    }
    options.testInterlock?.('binstall-before-leaf-remove', file.dest);
    requireBinLifecycleLease(lease, binDir);
    const result = removeOwnedRegularFile(path, snapshot.expectedDestination, {
      assertOwnership: () => requireBinLifecycleLease(lease, binDir),
      lifecycleLease: lease,
      testInterlock: options.testInterlock,
    });
    if (result === true) {
      removed++;
      // A successor can occupy the canonical name after the validated
      // removal; retain its preflight dependency closure before removing
      // lower-level runtime leaves.
      protectSurvivingLeaf(
        file, path, snapshot, snapshots, dependencyGraph, protectedBy, skipped, binDir, state,
      );
    } else {
      reportRemovalRace(binDir, path, skipped, recovery, result);
      // A foreign successor is opaque: its imports are never inferred from
      // current source or foreign bytes; preserve the complete closure.
      protectSurvivingLeaf(
        file, path, snapshot, snapshots, dependencyGraph, protectedBy, skipped, binDir, state,
      );
    }
  }

  // Remove legacy/renamed sentinel leaves before the boundary as well, so the
  // package.json boundary is the final runtime leaf removed. Keep the root
  // cache reserved and sweep bins/libs before the boundary/root cleanup.
  for (const sub of state.opaqueImporter ? [] : ['bin', 'lib']) {
    const dir = join(binDir, sub);
    const known = new Set(BinFiles.filter((f) => f.dest.startsWith(`${sub}/`)).map((f) => leaf(f.dest)));
    requireBinLifecycleLease(lease, binDir);
    const orphanReport = pruneOrphans(dir, known, SetForBin, {
      beforeRemove: () => requireBinLifecycleLease(lease, binDir),
      assertOwnership: () => requireBinLifecycleLease(lease, binDir),
      recovery: { lifecycleLease: lease },
      testInterlock: options.testInterlock,
    });
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
    requireBinLifecycleLease(lease, binDir);
    rmdirIfEmpty(dir, () => requireBinLifecycleLease(lease, binDir));
  }

  const boundarySnapshot = snapshots.get(BoundaryFile.dest);
  if (boundarySnapshot.present && protectedBy.has(BoundaryFile.dest)) {
    addUnique(skipped, BoundaryFile.dest);
  } else if (boundarySnapshot.present) {
    options.testInterlock?.('binstall-before-boundary-remove');
    requireBinLifecycleLease(lease, binDir);
    const result = removeOwnedRegularFile(
      join(binDir, BoundaryFile.dest), boundarySnapshot.expectedDestination,
      { assertOwnership: () => requireBinLifecycleLease(lease, binDir),
        lifecycleLease: lease,
        testInterlock: options.testInterlock },
    );
    if (result === true) {
      removed++;
    } else {
      reportRemovalRace(
        binDir,
        join(binDir, BoundaryFile.dest),
        skipped,
        recovery,
        result,
      );
    }
  }

  // The root sweep is namespace maintenance only; `cache` is deliberately
  // reserved and cannot be removed by this lifecycle.
  if (!state.opaqueImporter) {
    const dir = binDir;
    const known = new Set(['bin', 'lib', ...ReservedRootEntries]);
    if (protectedBy.has(BoundaryFile.dest)) known.add(BoundaryFile.dest);
    requireBinLifecycleLease(lease, binDir);
    const orphanReport = pruneOrphans(dir, known, SetForBin, {
      beforeRemove: () => requireBinLifecycleLease(lease, binDir),
      assertOwnership: () => requireBinLifecycleLease(lease, binDir),
      recovery: { lifecycleLease: lease },
      testInterlock: options.testInterlock,
    });
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
  }
  requireBinLifecycleLease(lease, binDir);
  rmdirIfEmpty(binDir, () => requireBinLifecycleLease(lease, binDir));

  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { removed, skipped, recovery, maintenance };
}

function mergeCacheMaintenance(
  binDir, recovery, maintenance, assertOwnershipCallback = null, lifecycleLease = null,
) {
  const cacheDir = join(binDir, 'cache');
  let cacheStat;
  try {
    cacheStat = lstatNoFollow(cacheDir);
  } catch (error) {
    // The cache is optional runtime state. Its permissions and health must
    // never become part of the install/uninstall transaction.
    markMaintenanceIncomplete(maintenance, binDir, error);
    return;
  }
  // The cache is reserved namespace, but it is not a traversal root for bin
  // lifecycle work. Only an actual directory is eligible for direct-entry
  // recovery inspection; a link or other entry is left completely alone.
  if (cacheStat === null || !cacheStat.isDirectory()) return;

  // No cache temp is considered ours from its name alone. The maintenance
  // primitive therefore sweeps nothing unless a caller supplies exact inode
  // proof, while still returning bounded, reportable crash leftovers.
  let report;
  try {
    report = maintainRecoveryArtifacts(cacheDir, {
      assertOwnership: assertOwnershipCallback, lifecycleLease,
    });
  } catch (error) {
    if (error?.leaseLost) throw error;
    markMaintenanceIncomplete(maintenance, cacheDir, error);
    return;
  }
  // Merge the cache report once into the structured maintenance contract.
  // The top-level recovery array is a compatibility projection used by the
  // install/uninstall reports, so it is populated separately below.
  mergeMaintenanceReport(maintenance, report,
    (path) => toBinRelative(binDir, path || cacheDir));
  for (const path of report.unprovedTemps || []) {
    const relativePath = toBinRelative(binDir, path);
    addUnique(recovery, relativePath);
  }
  for (const path of report.recovery || []) {
    addUnique(recovery, toBinRelative(binDir, path));
  }
}

function markMaintenanceIncomplete(maintenance, path, error) {
  maintenance.incomplete = true;
  if (maintenance.failures.length < 8) {
    maintenance.failures.push({
      path: path ? String(path) : '',
      code: error?.code || 'UNKNOWN',
    });
  }
}

function reportRemovalRace(binDir, path, skipped, recovery, result) {
  if (stablePathExists(path)) addUnique(skipped, toBinRelative(binDir, path));
  if (result?.preservedPath) addUnique(recovery, toBinRelative(binDir, result.preservedPath));
}

function toBinRelative(binDir, path) {
  return relative(binDir, path).split(sep).join('/');
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function mergeOrphanReport(skipped, recovery, binDir, report, maintenance = null) {
  for (const path of report.preserved) {
    addUnique(skipped, toBinRelative(binDir, path));
  }
  for (const path of report.recovery) {
    addUnique(recovery, toBinRelative(binDir, path));
  }
  if (maintenance) {
    mergeMaintenanceReport(maintenance, report.maintenance,
      (path) => toBinRelative(binDir, path));
  }
}

function rmdirIfEmpty(dir, assertOwnershipCallback = null) {
  assertOwnershipCallback?.();
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY (foreign files remain) or ENOENT — both fine, leave it.
  }
}
