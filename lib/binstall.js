import { lstatSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SentinelBin, SetForBin, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, removeOwnedRegularFile, sameFileIdentity,
  stablePathExists, writeFileAtomic, maintainRecoveryArtifacts,
  mergeMaintenanceReport,
} from './fsutil.js';
import { acquireLease, LEASE_MAX_MS, releaseLease, renewLease } from './lease-lock.js';

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

// The companion bins are self-contained under a mirrored bin/ + lib/ tree.
// Keep every relative ESM dependency in this list so installed hooks do not
// accidentally resolve against the caller's project.
const BinFileDefinitions = [
  // Node 18 does not perform the syntax detection that newer Node releases
  // use for these copied .js modules. This explicit boundary is itself a
  // managed leaf so install/list/remove/orphan handling remains symmetric.
  { src: 'lib/cah-bin-package.json', dest: 'package.json', mode: 0o644 },
  // Keep this registry in publication order. The package boundary comes first,
  // followed by the dependency chain from low-level helpers to shared
  // libraries, and only then the executable leaves. A new executable must
  // never become visible while one of its new relative imports is absent.
  { src: 'lib/sentinel.js', dest: 'lib/sentinel.js', mode: 0o755 },
  { src: 'lib/fs-atomic-identity.js', dest: 'lib/fs-atomic-identity.js', mode: 0o755 },
  { src: 'lib/fs-atomic-publication.js', dest: 'lib/fs-atomic-publication.js', mode: 0o755 },
  { src: 'lib/lease-lock.js', dest: 'lib/lease-lock.js', mode: 0o755 },
  { src: 'lib/fs-atomic.js', dest: 'lib/fs-atomic.js', mode: 0o755 },
  { src: 'lib/fsutil.js', dest: 'lib/fsutil.js', mode: 0o755 },
  { src: 'lib/marker-capacity-stage.js', dest: 'lib/marker-capacity-stage.js', mode: 0o755 },
  { src: 'lib/marker-state.js', dest: 'lib/marker-state.js', mode: 0o755 },
  { src: 'lib/transcript-stats.js', dest: 'lib/transcript-stats.js', mode: 0o755 },
  { src: 'lib/update-check.js', dest: 'lib/update-check.js', mode: 0o755 },
  { src: 'bin/cah-checkpoint-hint.js', dest: 'bin/cah-checkpoint-hint.js', mode: 0o755 },
  { src: 'bin/cah-status.js', dest: 'bin/cah-status.js', mode: 0o755 },
  { src: 'bin/cah-stamp.js', dest: 'bin/cah-stamp.js', mode: 0o755 },
  { src: 'bin/cah-status-probe.js', dest: 'bin/cah-status-probe.js', mode: 0o755 },
];

const LOCAL_IMPORT_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g;

function posixPath(path) {
  return path.split(sep).join('/');
}

function localModuleDest(importer, specifier, sourceRoot, byDest) {
  const importedPath = resolve(sourceRoot, dirname(importer), specifier);
  const candidates = [importedPath, `${importedPath}.js`, join(importedPath, 'index.js')];
  const candidate = candidates.find((path) => byDest.has(posixPath(relative(sourceRoot, path))));
  if (!candidate) {
    const relativeImport = posixPath(relative(sourceRoot, importedPath));
    throw new Error(
      `companion runtime leaf ${importer} imports unmanaged local module ${relativeImport}`,
    );
  }
  return posixPath(relative(sourceRoot, candidate));
}

function companionImportGraph(files, sourceRoot = PACKAGE_ROOT) {
  const root = resolve(sourceRoot);
  const byDest = new Map();
  for (const file of files) {
    if (byDest.has(file.dest)) throw new Error(`duplicate companion runtime destination ${file.dest}`);
    byDest.set(file.dest, file);
  }

  const graph = new Map();
  for (const file of files) {
    const source = readFileSync(join(root, file.src), 'utf8');
    const dependencies = new Set();
    for (const match of source.matchAll(LOCAL_IMPORT_RE)) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const dependency = localModuleDest(file.src, specifier, root, byDest);
        if (dependency !== file.dest) dependencies.add(dependency);
      }
    }
    graph.set(file.dest, dependencies);
  }
  return graph;
}

function deriveCompanionPublicationOrder(files, sourceRoot = PACKAGE_ROOT) {
  const graph = companionImportGraph(files, sourceRoot);
  const boundary = files.filter((file) => file.dest === 'package.json');
  if (boundary.length !== 1) throw new Error('companion runtime requires exactly one package.json boundary');
  const boundaryFile = boundary[0];
  const emitted = new Set();
  const ordered = [];

  while (ordered.length < files.length) {
    const librariesComplete = files
      .filter((file) => file.dest.startsWith('lib/'))
      .every((file) => emitted.has(file.dest));
    const next = files.find((file) => !emitted.has(file.dest)
      && [...graph.get(file.dest)].every((dependency) => emitted.has(dependency))
      && (file === boundaryFile ? ordered.length === 0
        : !file.dest.startsWith('bin/') || librariesComplete));
    if (!next) {
      const pending = files
        .filter((file) => !emitted.has(file.dest))
        .map((file) => file.dest)
        .join(', ');
      throw new Error(`companion runtime dependency graph is cyclic or cannot satisfy publication phases: ${pending}`);
    }
    emitted.add(next.dest);
    ordered.push(next);
  }
  return ordered;
}

export function getBinFileImportGraph(files = BinFiles, sourceRoot = PACKAGE_ROOT) {
  return companionImportGraph(files, sourceRoot);
}

export function deriveBinFilePublicationOrder(files = BinFiles, sourceRoot = PACKAGE_ROOT) {
  return deriveCompanionPublicationOrder(files, sourceRoot);
}

export function validateBinFileOrder(files = BinFiles, sourceRoot = PACKAGE_ROOT) {
  const graph = companionImportGraph(files, sourceRoot);
  const positions = new Map(files.map((file, index) => [file.dest, index]));
  const boundaryIndex = positions.get('package.json');
  if (boundaryIndex !== 0) throw new Error('companion package.json boundary must be published first');
  const firstExecutable = files.findIndex((file) => file.dest.startsWith('bin/'));
  if (firstExecutable !== -1 && files.slice(firstExecutable).some((file) => file.dest.startsWith('lib/'))) {
    throw new Error('companion executable leaves must be published after every library leaf');
  }
  for (const [importer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (positions.get(dependency) >= positions.get(importer)) {
        throw new Error(`companion publication order places importer ${importer} before dependency ${dependency}`);
      }
    }
  }
  return { graph, order: files.map((file) => file.dest) };
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

// Ride the sentinel as the line after the shebang (or the first line if there
// is none). Idempotent: source files in the package never carry it.
function injectSentinel(buf) {
  const text = buf.toString('utf8');
  if (text.includes(SentinelBin)) return buf;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    if (nl !== -1) {
      // Normalize the shebang line to LF: when source files are checked out
      // with CRLF (git core.autocrlf on Windows), `nl` lands on the \n of \r\n
      // and the slice would keep the \r, producing a mixed-newline file.
      const lineEnd = nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl;
      return Buffer.from(
        text.slice(0, lineEnd) + '\n' + SentinelBin + '\n' + text.slice(nl + 1),
        'utf8',
      );
    }
  }
  return Buffer.from(SentinelBin + '\n' + text, 'utf8');
}

export function writeBins(binDir, sourceRoot, options = {}) {
  if (!binDir) throw new Error('writeBins: nil binDir');
  if (!sourceRoot) throw new Error('writeBins: nil sourceRoot');

  return withBinLifecycleLease(binDir, (lease) => writeBinsUnlocked(binDir, sourceRoot, lease, options), options);
}

function requireBinLifecycleLease(lease, binDir) {
  if (!renewLease(lease)) throw new BinLifecycleLeaseLostError(binDir);
}

function assertBinLifecycleOwnership(lease, binDir) {
  requireBinLifecycleLease(lease, binDir);
}

function writeBinsUnlocked(binDir, sourceRoot, lease, options = {}) {

  // The companion bins are one runtime closure, not independent optional
  // files. Capture every declared destination before creating a directory or
  // publishing any leaf. A foreign dependency or executable would otherwise
  // leave a mixed runtime that can fail only after install has reported
  // success, so all foreign declared leaves are an explicit zero-mutation
  // failure. Unknown extra files remain outside this closure and are still
  // preserved and reported by the orphan sweep below.
  const snapshots = preflightBinLeaves(binDir);
  const publicationFiles = deriveBinFilePublicationOrder(BinFiles, sourceRoot);
  const dependencyGraph = companionImportGraph(publicationFiles, sourceRoot);
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
    const boundaryPublication = publishBinFile(
      binDir, sourceRoot, BoundaryFile, boundary.snapshot,
      () => assertBinLifecycleOwnership(lease, binDir), lease,
    );
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
      const payload = injectSentinel(readFileSync(join(sourceRoot, f.src)));
      requireBinLifecycleLease(lease, binDir);
      mkdirSync(dirname(destPath), { recursive: true });
      requireBinLifecycleLease(lease, binDir);
      const publication = writeFileAtomic(destPath, payload, {
        mode: f.mode,
        expectedDestination: snapshot.expectedDestination,
        assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
        lifecycleLease: lease,
        testInterlock: options.testInterlock,
      });
      published.push({ file: f, path: destPath, prior: snapshot, publication });
      written++;
      publishedLeaves++;
      if (publishedLeaves === 1) options.testInterlock?.('binstall-after-first-leaf');
    }

    requireBinLifecycleLease(lease, binDir);
    assertPublishedBoundary(boundary.path, boundaryPublication);

    requireBinLifecycleLease(lease, binDir);
    mergeCacheMaintenance(
      binDir, recovery, maintenance, () => assertBinLifecycleOwnership(lease, binDir), lease,
    );

    let pruned = 0;
    for (const [sub, known] of Object.entries(OwnedDirs)) {
      const dir = sub ? join(binDir, sub) : binDir;
      requireBinLifecycleLease(lease, binDir);
      const orphanReport = pruneOrphans(dir, known, SetForBin, {
        beforeRemove: () => requireBinLifecycleLease(lease, binDir),
        assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
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
      published, lease, binDir, dependencyGraph, options,
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
  binDir, sourceRoot, file, snapshot, assertOwnershipCallback = null, lifecycleLease = null,
) {
  const destPath = join(binDir, file.dest);
  const payload = injectSentinel(readFileSync(join(sourceRoot, file.src)));
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

function assertPublishedBoundary(path, publication) {
  const current = captureRegularFileSnapshot(path);
  if (!current.present
      || !sameFileIdentity(current.expectedDestination.identity, publication.identity)
      || current.contentDigest !== publication.contentDigest
      || current.contentBytes !== publication.contentBytes) {
    throw new Error(`managed package boundary changed concurrently at ${path}; refusing operation`);
  }
}

function rollbackPublishedLeaves(published, lease, binDir, dependencyGraph, options = {}) {
  const report = {
    incomplete: false,
    failed: [],
    failedExecutables: [],
    survivors: [],
    protected: [],
    protectedDependencies: [],
  };
  const protectedBy = new Map();

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
          assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
          lifecycleLease: lease,
          testInterlock: options.testInterlock,
          ...(item.file === BoundaryFile
            ? { testInterlockPhase: 'binstall-rollback-before-final' }
            : {}),
        });
      } else {
        requireBinLifecycleLease(lease, binDir);
        removeOwnedRegularFile(item.path, item.publication.expectedDestination, {
          assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
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
  }
  report.incomplete = report.failed.length > 0 || report.protected.length > 0;
  return report;
}

function sameRollbackState(current, prior) {
  if (!current.present || !prior.present) return current.present === prior.present;
  return current.contentDigest === prior.contentDigest
    && current.contentBytes === prior.contentBytes;
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

function attachRollbackRecovery(error, report) {
  error.rollback = report;
  error.recovery = report;
  error.rollbackIncomplete = true;
  const failed = report.failed.map((entry) => `${entry.dest} (${entry.reason})`);
  const protectedPaths = report.protected.map((entry) => entry.dest);
  const details = [...failed, ...protectedPaths.map((dest) => `${dest} (protected)`)];
  error.message += `; incomplete rollback recovery: ${details.join(', ')}`;
}

export function removeBins(binDir, _sourceRoot = undefined, maybeOptions = undefined) {
  if (!binDir) throw new Error('removeBins: nil binDir');
  const options = maybeOptions || (_sourceRoot && typeof _sourceRoot === 'object' ? _sourceRoot : {});

  return withBinLifecycleLease(binDir, (lease) => removeBinsUnlocked(binDir, lease, options), options);
}

function removeBinsUnlocked(binDir, lease, options = {}) {

  // Match install's closure rule: a foreign declared runtime leaf makes the
  // operation fail before the first removal. This prevents uninstall from
  // silently deleting the rest of a runtime it no longer owns.
  const snapshots = preflightBinLeaves(binDir);
  let removed = 0;
  const skipped = [];
  const recovery = [];
  const maintenance = emptyMaintenanceReport();

  requireBinLifecycleLease(lease, binDir);
    mergeCacheMaintenance(
    binDir, recovery, maintenance, () => assertBinLifecycleOwnership(lease, binDir), lease,
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
    options.testInterlock?.('binstall-before-leaf-remove');
    requireBinLifecycleLease(lease, binDir);
    const result = removeOwnedRegularFile(path, snapshot.expectedDestination, {
      assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
      lifecycleLease: lease,
      testInterlock: options.testInterlock,
    });
    if (result === true) {
      removed++;
    } else {
      reportRemovalRace(binDir, path, skipped, recovery, result);
    }
  }

  // Remove legacy/renamed sentinel leaves before the boundary as well, so the
  // package.json boundary is the final runtime leaf removed. Keep the root
  // cache reserved and sweep bins/libs before the boundary/root cleanup.
  for (const sub of ['bin', 'lib']) {
    const dir = sub ? join(binDir, sub) : binDir;
    const known = sub
      ? new Set(BinFiles.filter((f) => f.dest.startsWith(`${sub}/`)).map((f) => leaf(f.dest)))
      : new Set(['bin', 'lib', ...ReservedRootEntries]);
    requireBinLifecycleLease(lease, binDir);
    const orphanReport = pruneOrphans(dir, known, SetForBin, {
      beforeRemove: () => requireBinLifecycleLease(lease, binDir),
      assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
      recovery: { lifecycleLease: lease },
      testInterlock: options.testInterlock,
    });
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
    if (sub) {
      requireBinLifecycleLease(lease, binDir);
      rmdirIfEmpty(dir, () => assertBinLifecycleOwnership(lease, binDir));
    }
  }

  const boundarySnapshot = snapshots.get(BoundaryFile.dest);
  if (boundarySnapshot.present) {
    options.testInterlock?.('binstall-before-boundary-remove');
    requireBinLifecycleLease(lease, binDir);
    const result = removeOwnedRegularFile(
      join(binDir, BoundaryFile.dest), boundarySnapshot.expectedDestination,
      { assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
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
  {
    const dir = binDir;
    const known = new Set(['bin', 'lib', ...ReservedRootEntries]);
    requireBinLifecycleLease(lease, binDir);
    const orphanReport = pruneOrphans(dir, known, SetForBin, {
      beforeRemove: () => requireBinLifecycleLease(lease, binDir),
      assertOwnership: () => assertBinLifecycleOwnership(lease, binDir),
      recovery: { lifecycleLease: lease },
      testInterlock: options.testInterlock,
    });
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
  }
  requireBinLifecycleLease(lease, binDir);
  rmdirIfEmpty(binDir, () => assertBinLifecycleOwnership(lease, binDir));

  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { removed, skipped, recovery, maintenance };
}

function emptyMaintenanceReport() {
  return {
    swept: [], preserved: [], recovery: [], unprovedTemps: [],
    incomplete: false, truncated: false, visits: 0, failures: [],
  };
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
