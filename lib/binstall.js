import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SentinelBin, SetForBin, classifyContent, Ownership } from './sentinel.js';
import { readFileMaybe, pruneOrphans } from './fsutil.js';

// The companion bins are nearly self-contained: each bin imports only
// lib/transcript-stats.js, which in turn imports only node:fs. We mirror the
// package's bin/ + lib/ layout under the destination so the bins' relative
// import ('../lib/transcript-stats.js') resolves unchanged.
export const BinFiles = [
  { src: 'bin/cah-status.js', dest: 'bin/cah-status.js' },
  { src: 'bin/cah-stamp.js', dest: 'bin/cah-stamp.js' },
  { src: 'bin/cah-checkpoint-hint.js', dest: 'bin/cah-checkpoint-hint.js' },
  { src: 'lib/transcript-stats.js', dest: 'lib/transcript-stats.js' },
];

// Subdirectories we own under the bin root, plus the set of leaf names we write
// into each. Used to prune orphans (renamed/removed bins) without touching
// foreign files.
const OwnedDirs = {
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
      return Buffer.from(text.slice(0, nl + 1) + SentinelBin + '\n' + text.slice(nl + 1), 'utf8');
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
    const [present, existing] = readFileMaybe(destPath);
    if (classifyContent(present, existing, SetForBin) === Ownership.foreign) {
      skipped.push(f.dest);
      continue;
    }
    const payload = injectSentinel(readFileSync(join(sourceRoot, f.src)));
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, payload);
    written++;
  }

  let pruned = 0;
  for (const [sub, known] of Object.entries(OwnedDirs)) {
    pruned += pruneOrphans(join(binDir, sub), known, SetForBin);
  }

  return { written, skipped, pruned };
}

export function removeBins(binDir) {
  if (!binDir) throw new Error('removeBins: nil binDir');

  let removed = 0;
  const skipped = [];
  for (const sub of Object.keys(OwnedDirs)) {
    const dir = join(binDir, sub);
    const before = countForeign(dir);
    removed += pruneOrphans(dir, new Set(), SetForBin);
    skipped.push(...before);
    rmdirIfEmpty(dir);
  }
  rmdirIfEmpty(binDir);

  return { removed, skipped };
}

function countForeign(dir) {
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
    const [present, content] = readFileMaybe(join(dir, entry.name));
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
