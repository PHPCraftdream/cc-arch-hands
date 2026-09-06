import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';
import {
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
} from './fs-atomic.js';

const QUARANTINE_CHILD = 'payload';

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
} from './fs-atomic.js';

export function normalizedRelativePath(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' ? '' : rel.split(sep).join('/');
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
    if (e.code === 'ENOENT') return { pruned, preserved, recovery };
    throw e;
  }
  // Recovery namespaces are excluded from ordinary ownership sweeps. Report
  // displaced payloads separately when their canonical leaf is missing so a
  // crash cannot hide the only remaining copy of user data.
  for (const artifact of enumerateRecoveryArtifacts(dir)) {
    if (artifact.displacedData && !artifact.canonicalPresent) addUnique(recovery, artifact.path);
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

    let present;
    let content;
    try {
      [present, content] = readFileMaybe(path);
    } catch {
      // An unreadable regular orphan cannot be classified safely. It is still
      // a stable canonical survivor and must remain visible to the caller.
      reportPreserved(path);
      continue;
    }
    const afterRead = regularFileIdentity(path);
    if (!sameFileIdentity(observed, afterRead)) {
      // The path may have survived while its inode or metadata changed. It is
      // still an actionable orphan candidate, but only report it after a
      // second identity check proves that the successor is stable.
      reportPreserved(path);
      continue;
    }
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership === Ownership.foreign) {
      reportPreserved(path);
      continue;
    }
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      waitForTestInterlock('prune-before-remove');
      const result = removeOwnedRegularFile(path, afterRead);
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
  return { pruned, preserved, recovery };
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
export function pruneOrphanDirs(root, knownNames, manifestLeaf, sentinelSet) {
  let pruned = 0;
  const preserved = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { pruned, preserved };
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isQuarantineName(entry.name)) continue;
    if (knownNames.has(entry.name)) continue;
    const dirPath = join(root, entry.name);
    let children;
    try {
      children = readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    // Never resolve a link at the ownership marker path. Only a regular file
    // named exactly `manifestLeaf` can make this directory pruneable.
    const recoveryEntries = children.filter((child) => isQuarantineName(child.name));
    const recoveryPaths = recoveryEntries.map((child) => relativePreservedPath(
      root, recoveryEntryPath(dirPath, child),
    ));
    const managedChildren = children.filter((child) => !isQuarantineName(child.name));
    const manifestEntry = managedChildren.find((child) => child.name === manifestLeaf);
    if (!manifestEntry || !manifestEntry.isFile()) continue;
    const manifestPath = join(dirPath, manifestLeaf);
    const manifestBefore = regularFileIdentity(manifestPath);
    if (!manifestBefore) continue;
    const [present, content] = readFileMaybe(manifestPath);
    const manifestAfter = regularFileIdentity(manifestPath);
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership !== Ownership.mine && ownership !== Ownership.legacy) continue;
    if (!sameFileIdentity(manifestBefore, manifestAfter)) continue;

    // Inspect only direct entries. Anything besides the one owned regular
    // manifest is user data, including links/junctions, empty directories,
    // sockets, and other special entries. Do not descend into or follow it.
    for (const recoveryPath of recoveryPaths) addUnique(preserved, recoveryPath);
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
    if (!sameFileIdentity(finalManifest, manifestAfter)) {
      addUnique(preserved, entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-manifest-remove');
    const removal = removeOwnedRegularFile(manifestPath, manifestAfter);
    if (removal !== true) {
      addUnique(preserved, entry.name);
      if (removal?.preservedPath) {
        const recoveryPath = relativePreservedPath(root, removal.preservedPath);
        if (recoveryPath !== null) addUnique(preserved, recoveryPath);
      }
      continue;
    }
    waitForTestInterlock('prune-before-rmdir');
    if (removeEmptyDirectory(dirPath)) pruned++;
    else addUnique(preserved, entry.name);
  }
  return { pruned, preserved };
}

function relativePreservedPath(root, path) {
  const rootAbs = resolve(root);
  const pathAbs = resolve(path);
  if (pathAbs !== rootAbs && !pathAbs.startsWith(`${rootAbs}${sep}`)) return null;
  const rel = pathAbs === rootAbs ? '' : pathAbs.slice(rootAbs.length + 1);
  return rel.replaceAll(sep, '/');
}

function recoveryEntryPath(dirPath, entry) {
  const path = join(dirPath, entry.name);
  if (!entry.isDirectory()) return path;
  const child = join(path, QUARANTINE_CHILD);
  return lstatMaybe(child) === null ? path : child;
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}
