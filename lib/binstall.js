import { lstatSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { SentinelBin, SetForBin, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, removeOwnedRegularFile, sameFileIdentity,
  stablePathExists, waitForTestInterlock, writeFileAtomic, maintainRecoveryArtifacts,
  mergeMaintenanceReport,
} from './fsutil.js';
import { acquireLease, LEASE_MAX_MS, releaseLease, renewLease } from './lease-lock.js';

// Keep the operation fence beside, rather than inside, the removable runtime
// tree.  A failed uninstall therefore cannot remove the lock that is needed
// to recover that uninstall, and install/uninstall always rendezvous on the
// same stable path.
const BIN_LIFECYCLE_LOCK_SUFFIX = '.lock';
const BIN_LIFECYCLE_KIND = 'cc-arch-hands-bin-lifecycle';

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
  }
}

function withBinLifecycleLease(binDir, operation) {
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
  });
  if (!lease) throw new BinLifecycleBusyError(binDir);
  try {
    // This pause is test-only and occurs after ownership is published but
    // before preflight, making contention tests deterministic while keeping
    // the entire lifecycle under the same lease.
    waitForTestInterlock('binstall-after-lease');
    return operation(lease);
  } finally {
    releaseLease(lease);
  }
}

// The companion bins are self-contained under a mirrored bin/ + lib/ tree.
// Keep every relative ESM dependency in this list so installed hooks do not
// accidentally resolve against the caller's project.
export const BinFiles = [
  // Node 18 does not perform the syntax detection that newer Node releases
  // use for these copied .js modules. This explicit boundary is itself a
  // managed leaf so install/list/remove/orphan handling remains symmetric.
  { src: 'lib/cah-bin-package.json', dest: 'package.json', mode: 0o644 },
  // Keep this registry in publication order. The package boundary comes first,
  // followed by the dependency chain from low-level helpers to shared
  // libraries, and only then the executable leaves. A new executable must
  // never become visible while one of its new relative imports is absent.
  { src: 'lib/sentinel.js', dest: 'lib/sentinel.js', mode: 0o755 },
  { src: 'lib/fs-atomic.js', dest: 'lib/fs-atomic.js', mode: 0o755 },
  { src: 'lib/fsutil.js', dest: 'lib/fsutil.js', mode: 0o755 },
  { src: 'lib/lease-lock.js', dest: 'lib/lease-lock.js', mode: 0o755 },
  { src: 'lib/marker-state.js', dest: 'lib/marker-state.js', mode: 0o755 },
  { src: 'lib/transcript-stats.js', dest: 'lib/transcript-stats.js', mode: 0o755 },
  { src: 'lib/update-check.js', dest: 'lib/update-check.js', mode: 0o755 },
  { src: 'bin/cah-checkpoint-hint.js', dest: 'bin/cah-checkpoint-hint.js', mode: 0o755 },
  { src: 'bin/cah-status.js', dest: 'bin/cah-status.js', mode: 0o755 },
  { src: 'bin/cah-stamp.js', dest: 'bin/cah-stamp.js', mode: 0o755 },
  { src: 'bin/cah-status-probe.js', dest: 'bin/cah-status-probe.js', mode: 0o755 },
];

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

export function writeBins(binDir, sourceRoot) {
  if (!binDir) throw new Error('writeBins: nil binDir');
  if (!sourceRoot) throw new Error('writeBins: nil sourceRoot');

  return withBinLifecycleLease(binDir, (lease) => writeBinsUnlocked(binDir, sourceRoot, lease));
}

function requireBinLifecycleLease(lease, binDir) {
  if (!renewLease(lease)) throw new BinLifecycleLeaseLostError(binDir);
}

function writeBinsUnlocked(binDir, sourceRoot, lease) {

  // The companion bins are one runtime closure, not independent optional
  // files. Capture every declared destination before creating a directory or
  // publishing any leaf. A foreign dependency or executable would otherwise
  // leave a mixed runtime that can fail only after install has reported
  // success, so all foreign declared leaves are an explicit zero-mutation
  // failure. Unknown extra files remain outside this closure and are still
  // preserved and reported by the orphan sweep below.
  const snapshots = preflightBinLeaves(binDir);
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
      binDir, sourceRoot, BoundaryFile, boundary.snapshot, () => requireBinLifecycleLease(lease, binDir),
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
    waitForTestInterlock('binstall-after-boundary');

    let publishedLeaves = 0;
    let executablePhaseStarted = false;
    for (const f of BinFiles) {
      if (f === BoundaryFile) continue;
      requireBinLifecycleLease(lease, binDir);
      assertPublishedBoundary(boundary.path, boundaryPublication);

      // All shared imports have been published before the first executable is
      // published. This interlock also gives tests a stable staged-tree
      // boundary to smoke.
      if (!executablePhaseStarted && f.dest.startsWith('bin/')) {
        waitForTestInterlock('binstall-after-dependencies');
        requireBinLifecycleLease(lease, binDir);
        executablePhaseStarted = true;
      }

      const destPath = join(binDir, f.dest);
      const snapshot = snapshots.get(f.dest);
      const payload = injectSentinel(readFileSync(join(sourceRoot, f.src)));
      requireBinLifecycleLease(lease, binDir);
      mkdirSync(dirname(destPath), { recursive: true });
      waitForTestInterlock('binstall-before-leaf-write');
      requireBinLifecycleLease(lease, binDir);
      const publication = writeFileAtomic(destPath, payload, {
        mode: f.mode,
        expectedDestination: snapshot.expectedDestination,
      });
      published.push({ file: f, path: destPath, prior: snapshot, publication });
      written++;
      publishedLeaves++;
      if (publishedLeaves === 1) waitForTestInterlock('binstall-after-first-leaf');
    }

    requireBinLifecycleLease(lease, binDir);
    assertPublishedBoundary(boundary.path, boundaryPublication);

    requireBinLifecycleLease(lease, binDir);
    mergeCacheMaintenance(binDir, recovery, maintenance);

    let pruned = 0;
    for (const [sub, known] of Object.entries(OwnedDirs)) {
      const dir = sub ? join(binDir, sub) : binDir;
      requireBinLifecycleLease(lease, binDir);
      const orphanReport = pruneOrphans(dir, known, SetForBin, {
        beforeRemove: () => requireBinLifecycleLease(lease, binDir),
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
    // Once the lease is gone, the path may belong to a complete successor
    // install. Never inspect it for rollback ownership or prune it further.
    requireBinLifecycleLease(lease, binDir);
    rollbackPublishedLeaves(published, lease, binDir);
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

function publishBinFile(binDir, sourceRoot, file, snapshot, beforeMutation = null) {
  const destPath = join(binDir, file.dest);
  const payload = injectSentinel(readFileSync(join(sourceRoot, file.src)));
  beforeMutation?.();
  mkdirSync(dirname(destPath), { recursive: true });
  beforeMutation?.();
  return writeFileAtomic(destPath, payload, {
    mode: file.mode,
    expectedDestination: snapshot.expectedDestination,
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

function rollbackPublishedLeaves(published, lease, binDir) {
  for (const item of [...published].reverse()) {
    requireBinLifecycleLease(lease, binDir);
    let current;
    try {
      current = captureRegularFileSnapshot(item.path);
    } catch {
      continue;
    }
    if (!current.present
        || !sameFileIdentity(current.expectedDestination.identity, item.publication.identity)
        || current.contentDigest !== item.publication.contentDigest
        || current.contentBytes !== item.publication.contentBytes) {
      // A successor now occupies the name. It is not ours to remove or
      // overwrite, even when the failed publication was ours.
      continue;
    }
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
          ...(item.file === BoundaryFile
            ? { testInterlockPhase: 'binstall-rollback-before-final' }
            : {}),
        });
      } else {
        requireBinLifecycleLease(lease, binDir);
        removeOwnedRegularFile(item.path, item.publication.expectedDestination);
      }
    } catch (error) {
      if (error?.code === 'ERR_BIN_LIFECYCLE_LEASE_LOST') throw error;
      // A successor may have reclaimed the lease while an atomic rollback
      // helper was paused at its final publication boundary. Surface that
      // ownership loss instead of allowing the original error to disguise it.
      requireBinLifecycleLease(lease, binDir);
      // The original publication error is authoritative. Any rollback race
      // is handled conservatively by leaving the current leaf in place.
    }
  }
}

export function removeBins(binDir) {
  if (!binDir) throw new Error('removeBins: nil binDir');

  return withBinLifecycleLease(binDir, (lease) => removeBinsUnlocked(binDir, lease));
}

function removeBinsUnlocked(binDir, lease) {

  // Match install's closure rule: a foreign declared runtime leaf makes the
  // operation fail before the first removal. This prevents uninstall from
  // silently deleting the rest of a runtime it no longer owns.
  const snapshots = preflightBinLeaves(binDir);
  let removed = 0;
  const skipped = [];
  const recovery = [];
  const maintenance = emptyMaintenanceReport();

  requireBinLifecycleLease(lease, binDir);
  mergeCacheMaintenance(binDir, recovery, maintenance);

  // BinFiles is published from the low-level dependency boundary towards the
  // executables. Its reverse is therefore the strict teardown order: every
  // executable, then dependent/shared libraries, then low-level libraries,
  // and the Node 18 ESM package boundary last.
  for (const file of [...BinFiles].reverse()) {
    if (file === BoundaryFile) continue;
    const snapshot = snapshots.get(file.dest);
    if (!snapshot.present) continue;
    const path = join(binDir, file.dest);
    waitForTestInterlock('binstall-before-leaf-remove');
    requireBinLifecycleLease(lease, binDir);
    const result = removeOwnedRegularFile(path, snapshot.expectedDestination);
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
    });
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
    if (sub) {
      requireBinLifecycleLease(lease, binDir);
      rmdirIfEmpty(dir);
    }
  }

  const boundarySnapshot = snapshots.get(BoundaryFile.dest);
  if (boundarySnapshot.present) {
    waitForTestInterlock('binstall-before-boundary-remove');
    requireBinLifecycleLease(lease, binDir);
    const result = removeOwnedRegularFile(
      join(binDir, BoundaryFile.dest), boundarySnapshot.expectedDestination,
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
    });
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport, maintenance);
  }
  requireBinLifecycleLease(lease, binDir);
  rmdirIfEmpty(binDir);

  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { removed, skipped, recovery, maintenance };
}

function emptyMaintenanceReport() {
  return {
    swept: [], preserved: [], recovery: [], unprovedTemps: [],
    incomplete: false, truncated: false, visits: 0, failures: [],
  };
}

function mergeCacheMaintenance(binDir, recovery, maintenance) {
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
    report = maintainRecoveryArtifacts(cacheDir);
  } catch (error) {
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

function rmdirIfEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY (foreign files remain) or ENOENT — both fine, leave it.
  }
}
