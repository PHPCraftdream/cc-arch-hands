import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { SentinelBin, SetForBin, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, removeOwnedRegularFile, sameFileIdentity,
  waitForTestInterlock, writeFileAtomic,
} from './fsutil.js';

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

  // A foreign package.json controls how every copied .js leaf is interpreted.
  // It is an internal managed-runtime boundary, so even a foreign ESM package
  // is rejected before any mutation rather than treated as a compatible shell.
  const boundary = preflightPackageBoundary(binDir);

  let written = 0;
  const skipped = [];
  const recovery = [];
  const published = [];

  try {
    // Publish the boundary before any bin/lib leaf. Its conditional expected
    // destination is the exact preflight identity, so a concurrent creator or
    // replacer cannot be overwritten.
    const boundaryPublication = publishBinFile(binDir, sourceRoot, BoundaryFile, boundary.snapshot);
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
      assertPublishedBoundary(boundary.path, boundaryPublication);

      // All shared imports have been published (or conservatively preserved
      // as foreign) before the first executable is even snapshotted. This
      // interlock also gives tests a stable staged-tree boundary to smoke.
      if (!executablePhaseStarted && f.dest.startsWith('bin/')) {
        waitForTestInterlock('binstall-after-dependencies');
        executablePhaseStarted = true;
      }

      const destPath = join(binDir, f.dest);
      const snapshot = captureRegularFileSnapshot(destPath);
      if (classifyContent(snapshot.present, snapshot.content, SetForBin) === Ownership.foreign) {
        skipped.push(f.dest);
        continue;
      }
      const payload = injectSentinel(readFileSync(join(sourceRoot, f.src)));
      mkdirSync(dirname(destPath), { recursive: true });
      waitForTestInterlock('binstall-before-leaf-write');
      const publication = writeFileAtomic(destPath, payload, {
        mode: f.mode,
        expectedDestination: snapshot.expectedDestination,
      });
      published.push({ file: f, path: destPath, prior: snapshot, publication });
      written++;
      publishedLeaves++;
      if (publishedLeaves === 1) waitForTestInterlock('binstall-after-first-leaf');
    }

    assertPublishedBoundary(boundary.path, boundaryPublication);

    let pruned = 0;
    for (const [sub, known] of Object.entries(OwnedDirs)) {
      const dir = sub ? join(binDir, sub) : binDir;
      const orphanReport = pruneOrphans(dir, known, SetForBin);
      pruned += orphanReport.pruned;
      mergeOrphanReport(skipped, recovery, binDir, orphanReport);
    }

    // Pruning is also part of the install transaction: do not claim success if
    // the runtime boundary was replaced while it was in progress.
    assertPublishedBoundary(boundary.path, boundaryPublication);
    return { written, skipped, recovery, pruned };
  } catch (error) {
    rollbackPublishedLeaves(published);
    throw error;
  }
}

function preflightPackageBoundary(binDir) {
  const packagePath = join(binDir, 'package.json');
  const snapshot = captureRegularFileSnapshot(packagePath);
  const ownership = classifyContent(snapshot.present, snapshot.content, SetForBin);
  if (snapshot.present && ownership === Ownership.foreign) {
    throw new Error(
      `foreign package boundary at ${packagePath}: managed companion bins require the cah-owned ESM package.json`,
    );
  }
  return { path: packagePath, snapshot, ownership };
}

function publishBinFile(binDir, sourceRoot, file, snapshot) {
  const destPath = join(binDir, file.dest);
  const payload = injectSentinel(readFileSync(join(sourceRoot, file.src)));
  mkdirSync(dirname(destPath), { recursive: true });
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

function rollbackPublishedLeaves(published) {
  for (const item of [...published].reverse()) {
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
        writeFileAtomic(item.path, item.prior.content, {
          mode: restoreMode,
          expectedDestination: item.publication.expectedDestination,
          ...(item.file === BoundaryFile
            ? { testInterlockPhase: 'binstall-rollback-before-final' }
            : {}),
        });
      } else {
        removeOwnedRegularFile(item.path, item.publication.expectedDestination);
      }
    } catch {
      // The original publication error is authoritative. Any rollback race
      // is handled conservatively by leaving the current leaf in place.
    }
  }
}

export function removeBins(binDir) {
  if (!binDir) throw new Error('removeBins: nil binDir');

  let removed = 0;
  const skipped = [];
  const recovery = [];
  for (const sub of Object.keys(OwnedDirs)) {
    const dir = sub ? join(binDir, sub) : binDir;
    // Removal must sweep the managed root package leaf too, while still
    // excluding the mirrored structural directories from root orphan scope.
    const known = sub ? new Set() : new Set(['bin', 'lib', ...ReservedRootEntries]);
    const orphanReport = pruneOrphans(dir, known, SetForBin);
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, recovery, binDir, orphanReport);
    if (sub) rmdirIfEmpty(dir);
  }
  rmdirIfEmpty(binDir);

  return { removed, skipped, recovery };
}

function toBinRelative(binDir, path) {
  return relative(binDir, path).split(sep).join('/');
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function mergeOrphanReport(skipped, recovery, binDir, report) {
  for (const path of report.preserved) {
    addUnique(skipped, toBinRelative(binDir, path));
  }
  for (const path of report.recovery) {
    addUnique(recovery, toBinRelative(binDir, path));
  }
}

function rmdirIfEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY (foreign files remain) or ENOENT — both fine, leave it.
  }
}
