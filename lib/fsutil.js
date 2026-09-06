import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';
import {
  writeFileAtomic,
  captureRegularFileSnapshot,
  regularFileIdentity,
  directoryIdentity,
  captureDirectoryIdentities,
  sameDirectoryIdentity,
  directoryIdentitiesMatch,
  sameFileIdentity,
  sameStatInteger,
  sameDeviceIdentity,
  mtimeMsForAge,
  isOlderThan,
  removeOwnedRegularFile,
  removeEmptyDirectory,
  waitForTestInterlock,
  isQuarantineName,
  isQuarantinePath,
  maintainRecoveryArtifacts,
} from './fs-atomic.js';

function lstatMaybe(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export {
  writeFileAtomic,
  readFileMaybe,
  captureRegularFileSnapshot,
  regularFileIdentity,
  directoryIdentity,
  captureDirectoryIdentities,
  sameDirectoryIdentity,
  directoryIdentitiesMatch,
  sameFileIdentity,
  sameStatInteger,
  sameDeviceIdentity,
  mtimeMsForAge,
  isOlderThan,
  removeOwnedRegularFile,
  removeEmptyDirectory,
  waitForTestInterlock,
  isQuarantineName,
  isQuarantinePath,
  enumerateRecoveryArtifacts,
  sweepRecoveryArtifacts,
  maintainRecoveryArtifacts,
} from './fs-atomic.js';

export function normalizedRelativePath(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' ? '' : rel.split(sep).join('/');
}

export function emptyMaintenanceReport() {
  return {
    swept: [], preserved: [], recovery: [], unprovedTemps: [],
    incomplete: false, truncated: false, visits: 0, failures: [],
  };
}

// Merge bounded recovery inspection state without allowing callers to lose a
// category or to emit the same path more than once. `mapPath` lets each
// installer expose paths in its own result namespace while retaining the
// structured maintenance contract.
export function mergeMaintenanceReport(target, report, mapPath = (path) => path) {
  if (!report) return target;
  target.incomplete ||= Boolean(report.incomplete);
  target.truncated ||= Boolean(report.truncated);
  target.visits += Number.isSafeInteger(report.visits) ? report.visits : 0;
  for (const failure of report.failures || []) {
    const mapped = {
      path: mapPath(failure.path || ''),
      code: failure.code || 'UNKNOWN',
    };
    if (!target.failures.some((item) => item.path === mapped.path && item.code === mapped.code)
        && target.failures.length < 8) target.failures.push(mapped);
  }
  for (const field of ['swept', 'preserved', 'recovery', 'unprovedTemps']) {
    for (const value of report[field] || []) {
      const path = typeof value === 'string' ? value : value?.path;
      if (path !== undefined) addUnique(target[field], mapPath(path));
    }
  }
  return target;
}

// List every regular file under `dir`, returned as paths relative to `dir`
// with '/' separators on all platforms. Returns [] if the directory is
// missing. Used to tell "files cah wrote" apart from files a user dropped
// into (or copied alongside) a skill directory.
export function listFilesRel(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      if (isQuarantineName(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out;
}

export function pruneOrphans(dir, knownNames, sentinelSet, options = {}) {
  let pruned = 0;
  const preserved = [];
  const recovery = [];
  const maintenance = emptyMaintenanceReport();
  const maintenanceReport = maintainRecoveryArtifacts(dir, options.recovery ?? {});
  mergeMaintenanceReport(maintenance, maintenanceReport);
  for (const path of maintenanceReport.recovery) addUnique(recovery, path);
  for (const path of maintenanceReport.preserved) addUnique(preserved, path);
  const reportPreserved = (path, result = undefined) => {
    if (!stableExistingPath(path)) return;
    addUnique(preserved, path);
    options.onPreserved?.(path, result);
  };
  const reportRecovery = (path, canonical = null) => {
    if (!path || (canonical !== null && !isRecoveryFor(canonical, path))) return;
    if (!stableExistingPath(path)) return;
    addUnique(recovery, path);
  };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { pruned, preserved, recovery, maintenance };
    throw e;
  }
  for (const entry of entries) {
    if (isQuarantineName(entry.name)) continue;
    if (knownNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    // Orphan scope is the direct, unknown namespace under `dir`. Inspect the
    // entry itself with lstat only: links, directories, sockets, and other
    // special entries are canonical survivors, never things to follow.
    const observedPath = lstatMaybe(path);
    if (observedPath === null) continue;
    if (!observedPath.isFile()) {
      reportPreserved(path);
      continue;
    }
    const observed = regularFileIdentity(path);
    if (!observed) continue;

    let snapshot;
    try {
      snapshot = captureRegularFileSnapshot(path);
    } catch {
      // An unreadable regular orphan cannot be classified safely. It is still
      // a stable canonical survivor and must remain visible to the caller.
      reportPreserved(path);
      continue;
    }
    if (!snapshot.present || !sameFileIdentity(observed, snapshot.expectedDestination.identity)) {
      // The path may have survived while its inode or metadata changed. It is
      // still an actionable orphan candidate, but only report it after a
      // second identity check proves that the successor is stable.
      reportPreserved(path);
      continue;
    }
    const ownership = classifyContent(snapshot.present, snapshot.content, sentinelSet);
    if (ownership === Ownership.foreign) {
      reportPreserved(path);
      continue;
    }
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      waitForTestInterlock('prune-before-remove');
      // Lifecycle owners may expire while the deterministic test/OS boundary
      // is paused. Let the caller revalidate ownership immediately before the
      // destructive orphan mutation rather than pruning a successor tree.
      options.beforeRemove?.(path, snapshot);
      const result = removeOwnedRegularFile(path, snapshot.expectedDestination);
      if (result === true) {
        pruned++;
      } else {
        // A false result means the validated orphan changed or disappeared;
        // report the canonical survivor and bounded recovery slot separately.
        // The two categories are intentionally never mixed.
        reportPreserved(path, result);
        reportRecovery(result?.preservedPath, path);
      }
    }
  }
  return { pruned, preserved, recovery, maintenance };
}

function stableExistingPath(path) {
  const before = lstatMaybe(path);
  if (before === null) return false;
  const after = lstatMaybe(path);
  if (after === null) return false;
  return before.isFile() && after.isFile()
    ? sameFileIdentity(before, after)
    : before.isDirectory() && after.isDirectory()
      ? sameDirectoryIdentity(before, after)
      : before.isSymbolicLink() && after.isSymbolicLink()
        ? sameStatInteger(before.dev, after.dev)
          && sameStatInteger(before.ino, after.ino)
          && sameStatInteger(before.mode, after.mode)
        : !before.isDirectory() && !before.isFile() && !before.isSymbolicLink()
          && !after.isDirectory() && !after.isFile() && !after.isSymbolicLink()
          && sameStatInteger(before.dev, after.dev)
          && sameStatInteger(before.ino, after.ino)
          && sameStatInteger(before.mode, after.mode);
}

// A reporting-only existence check. It deliberately uses lstat and two
// observations so callers can distinguish a stable canonical successor from
// a path that disappeared during a removal race without following links.
export function stablePathExists(path) {
  return stableExistingPath(path);
}

function isRecoveryFor(canonical, recoveryPath) {
  const recoveryRoot = `${canonical}.cah-owned-remove`;
  const canonicalRecovery = resolve(recoveryPath);
  const root = resolve(recoveryRoot);
  return canonicalRecovery === root || canonicalRecovery.startsWith(`${root}${sep}`);
}

// Prune directories under `root` whose name is no longer in `knownNames` but
// whose manifest leaf carries one of our sentinels. Returns
// { pruned, preserved } — `preserved` lists orphan dirs that were NOT deleted
// because they hold files beyond the owned manifest (e.g. a user copied an
// installed skill as a starting point and added their own files; wiping the
// whole tree would silently destroy that data).
export function pruneOrphanDirs(root, knownNames, manifestLeaf, sentinelSet, options = {}) {
  let pruned = 0;
  const preserved = [];
  const recovery = [];
  const maintenance = emptyMaintenanceReport();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { pruned, preserved, recovery, maintenance };
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isQuarantineName(entry.name)) continue;
    if (knownNames.has(entry.name)) continue;
    const dirPath = join(root, entry.name);
    const maintenanceReport = maintainRecoveryArtifacts(dirPath, options.recovery ?? {});
    mergeMaintenanceReport(maintenance, maintenanceReport, (path) => relativePreservedPath(root, path) ?? path);
    for (const path of maintenanceReport.recovery) {
      const rel = relativePreservedPath(root, path);
      if (rel !== null) addUnique(recovery, rel);
    }
    for (const path of maintenanceReport.preserved) {
      const rel = relativePreservedPath(root, path);
      if (rel !== null) addUnique(preserved, rel);
    }
    let children;
    try {
      children = readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    // Never resolve a link at the ownership marker path. Only a regular file
    // named exactly `manifestLeaf` can make this directory pruneable.
    const managedChildren = children.filter((child) => !isQuarantineName(child.name));
    const manifestEntry = managedChildren.find((child) => child.name === manifestLeaf);
    if (!manifestEntry || !manifestEntry.isFile()) continue;
    const manifestPath = join(dirPath, manifestLeaf);
    let manifestSnapshot;
    try {
      manifestSnapshot = captureRegularFileSnapshot(manifestPath);
    } catch {
      addUnique(preserved, entry.name);
      continue;
    }
    if (!manifestSnapshot.present) continue;
    const ownership = classifyContent(
      manifestSnapshot.present, manifestSnapshot.content, sentinelSet,
    );
    if (ownership !== Ownership.mine && ownership !== Ownership.legacy) continue;
    const manifestExpected = manifestSnapshot.expectedDestination;

    // Inspect only direct entries. Anything besides the one owned regular
    // manifest is user data, including links/junctions, empty directories,
    // sockets, and other special entries. Do not descend into or follow it.
    if (managedChildren.length !== 1) {
      addUnique(preserved, entry.name);
      continue;
    }
    // Close the widest practical race before removing the manifest: if any
    // entry appeared or the manifest changed type, preserve the directory.
    const current = readdirSync(dirPath, { withFileTypes: true });
    const currentManaged = current.filter((child) => !isQuarantineName(child.name));
    if (currentManaged.length !== 1
        || currentManaged[0].name !== manifestLeaf
        || !currentManaged[0].isFile()) {
      addUnique(preserved, entry.name);
      continue;
    }
    const finalManifest = regularFileIdentity(manifestPath);
    if (!sameFileIdentity(finalManifest, manifestExpected.identity)) {
      addUnique(preserved, entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-manifest-remove');
    const removal = removeOwnedRegularFile(manifestPath, manifestExpected);
    if (removal !== true) {
      addUnique(preserved, entry.name);
      if (removal?.preservedPath) {
        const recoveryPath = relativePreservedPath(root, removal.preservedPath);
        if (recoveryPath !== null) addUnique(recovery, recoveryPath);
      }
      continue;
    }
    waitForTestInterlock('prune-before-rmdir');
    if (removeEmptyDirectory(dirPath)) pruned++;
    else addUnique(preserved, entry.name);
  }
  return { pruned, preserved, recovery, maintenance };
}

function relativePreservedPath(root, path) {
  const rootAbs = resolve(root);
  const pathAbs = resolve(path);
  if (pathAbs !== rootAbs && !pathAbs.startsWith(`${rootAbs}${sep}`)) return null;
  const rel = pathAbs === rootAbs ? '' : pathAbs.slice(rootAbs.length + 1);
  return rel.replaceAll(sep, '/');
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}
