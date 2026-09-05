import { mkdirSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
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
    pruned += pruneOrphans(dir, known, SetForBin, {
      onPreserved: (path) => addUnique(skipped, toBinRelative(binDir, path)),
    });
  }

  return { written, skipped, pruned };
}

export function removeBins(binDir) {
  if (!binDir) throw new Error('removeBins: nil binDir');

  let removed = 0;
  const skipped = [];
  const preserved = new Set();
  for (const sub of Object.keys(OwnedDirs)) {
    const dir = sub ? join(binDir, sub) : binDir;
    removed += pruneOrphans(dir, new Set(), SetForBin, {
      onPreserved: (path) => {
        preserved.add(path);
        addUnique(skipped, toBinRelative(binDir, path));
      },
    });
    // Count survivors after the identity-checked prune so a foreign
    // successor installed during pruning is reported and not mistaken for a
    // removed file.
    for (const path of countForeign(dir, preserved)) addUnique(skipped, path);
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

function countForeign(dir, ignoredPaths = new Set()) {
  const foreign = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return foreign;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    if (ignoredPaths.has(path)) continue;
    let present = true;
    let content;
    try {
      content = readFileSync(path);
    } catch (e) {
      if (e.code === 'ENOENT') present = false;
      else throw e;
    }
    if (classifyContent(present, content, SetForBin) === Ownership.foreign) {
      foreign.push(entry.name);
    }
  }
  return foreign;
}

function rmdirIfEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    // ENOTEMPTY (foreign files remain) or ENOENT — both fine, leave it.
  }
}
