import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { SentinelBin, SetForBin, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, writeFileAtomic,
} from './fsutil.js';

// The companion bins are self-contained under a mirrored bin/ + lib/ tree.
// Keep every relative ESM dependency in this list so installed hooks do not
// accidentally resolve against the caller's project.
export const BinFiles = [
  { src: 'bin/cah-status.js', dest: 'bin/cah-status.js', mode: 0o755 },
  { src: 'bin/cah-stamp.js', dest: 'bin/cah-stamp.js', mode: 0o755 },
  { src: 'bin/cah-checkpoint-hint.js', dest: 'bin/cah-checkpoint-hint.js', mode: 0o755 },
  { src: 'bin/cah-status-probe.js', dest: 'bin/cah-status-probe.js', mode: 0o755 },
  { src: 'lib/transcript-stats.js', dest: 'lib/transcript-stats.js', mode: 0o755 },
  { src: 'lib/update-check.js', dest: 'lib/update-check.js', mode: 0o755 },
  { src: 'lib/lease-lock.js', dest: 'lib/lease-lock.js', mode: 0o755 },
  { src: 'lib/fsutil.js', dest: 'lib/fsutil.js', mode: 0o755 },
  { src: 'lib/sentinel.js', dest: 'lib/sentinel.js', mode: 0o755 },
  // Node 18 does not perform the syntax detection that newer Node releases
  // use for these copied .js modules. This explicit boundary is itself a
  // managed leaf so install/list/remove/orphan handling remains symmetric.
  { src: 'lib/cah-bin-package.json', dest: 'package.json', mode: 0o644 },
];

// Subdirectories we own under the bin root, plus the set of leaf names we write
// into each. Used to prune orphans (renamed/removed bins) without touching
// foreign files.
const OwnedDirs = {
  '': new Set(BinFiles.filter((f) => !f.dest.includes('/')).map((f) => leaf(f.dest))),
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
  // Check that boundary before creating, chmod'ing, publishing, or pruning any
  // bin/lib leaf. A foreign ESM boundary is compatible and remains untouched;
  // every other foreign boundary would leave an install that Node cannot run.
  preflightPackageBoundary(binDir);

  let written = 0;
  const skipped = [];

  for (const f of BinFiles) {
    const destPath = join(binDir, f.dest);
    const snapshot = captureRegularFileSnapshot(destPath);
    if (classifyContent(snapshot.present, snapshot.content, SetForBin) === Ownership.foreign) {
      skipped.push(f.dest);
      continue;
    }
    const payload = injectSentinel(readFileSync(join(sourceRoot, f.src)));
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileAtomic(destPath, payload, {
      mode: f.mode,
      expectedDestination: snapshot.expectedDestination,
    });
    written++;
  }

  let pruned = 0;
  for (const [sub, known] of Object.entries(OwnedDirs)) {
    const dir = sub ? join(binDir, sub) : binDir;
    const orphanReport = pruneOrphans(dir, known, SetForBin);
    pruned += orphanReport.pruned;
    mergeOrphanReport(skipped, binDir, orphanReport);
  }

  return { written, skipped, pruned };
}

function preflightPackageBoundary(binDir) {
  const packagePath = join(binDir, 'package.json');
  const snapshot = captureRegularFileSnapshot(packagePath);
  const ownership = classifyContent(snapshot.present, snapshot.content, SetForBin);
  if (!snapshot.present || ownership === Ownership.mine || ownership === Ownership.legacy) {
    return;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(snapshot.content.toString('utf8'));
  } catch (error) {
    throw new Error(
      `malformed foreign package boundary at ${packagePath}: package.json is not valid JSON`,
      { cause: error },
    );
  }
  if (packageJson?.type !== 'module') {
    throw new Error(
      `incompatible foreign package boundary at ${packagePath}: package.json must declare type: module`,
    );
  }
}

export function removeBins(binDir) {
  if (!binDir) throw new Error('removeBins: nil binDir');

  let removed = 0;
  const skipped = [];
  for (const sub of Object.keys(OwnedDirs)) {
    const dir = sub ? join(binDir, sub) : binDir;
    const orphanReport = pruneOrphans(dir, new Set(), SetForBin);
    removed += orphanReport.pruned;
    mergeOrphanReport(skipped, binDir, orphanReport);
    if (sub) rmdirIfEmpty(dir);
  }
  rmdirIfEmpty(binDir);

  return { removed, skipped };
}

function toBinRelative(binDir, path) {
  return relative(binDir, path).split(sep).join('/');
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function mergeOrphanReport(skipped, binDir, report) {
  for (const path of report.preserved) {
    addUnique(skipped, toBinRelative(binDir, path));
  }
}

function rmdirIfEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY (foreign files remain) or ENOENT — both fine, leave it.
  }
}
