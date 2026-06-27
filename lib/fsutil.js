import { readFileSync, readdirSync, unlinkSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';

// Write `payload` to `destPath` via a temp file + rename so an interrupted or
// failed write never leaves a half-written file. This matters for files whose
// ownership sentinel sits at the end of the body: a torn write would drop the
// sentinel and get the file misclassified as foreign (and thus stuck).
export function writeFileAtomic(destPath, payload) {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.cah-tmp`;
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, destPath);
  } catch (e) {
    // Don't strand a half-written temp file (it would later be mistaken for a
    // user file inside a skill dir). Best-effort cleanup, then rethrow.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore — nothing more we can do
    }
    throw e;
  }
}

export function readFileMaybe(path) {
  try {
    return [true, readFileSync(path)];
  } catch (e) {
    if (e.code === 'ENOENT') return [false, null];
    throw e;
  }
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

export function pruneOrphans(dir, knownNames, sentinelSet) {
  let pruned = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (knownNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const [present, content] = readFileMaybe(path);
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      unlinkSync(path);
      pruned++;
    }
  }
  return pruned;
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
    if (knownNames.has(entry.name)) continue;
    const dirPath = join(root, entry.name);
    const manifestPath = join(dirPath, manifestLeaf);
    const [present, content] = readFileMaybe(manifestPath);
    const ownership = classifyContent(present, content, sentinelSet);
    if (ownership !== Ownership.mine && ownership !== Ownership.legacy) continue;

    const extras = listFilesRel(dirPath).filter((rel) => rel !== manifestLeaf);
    if (extras.length > 0) {
      preserved.push(entry.name);
      continue;
    }
    rmSync(dirPath, { recursive: true, force: true });
    pruned++;
  }
  return { pruned, preserved };
}
