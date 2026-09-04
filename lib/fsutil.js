import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';

// Write `payload` to `destPath` via an exclusively-created, unpredictable
// sibling temp + rename so an interrupted or failed write never exposes a
// half-written destination. This matters for files whose ownership sentinel
// sits at the end of the body: a torn write would drop the sentinel and get
// the file misclassified as foreign (and thus stuck).
//
// The rename is retried for transient OS errors: on Windows, antivirus tools
// and the search indexer briefly lock a freshly-written file, so an immediate
// rename-over-existing can fail with EPERM/EBUSY/ENOTEMPTY/EACCES even though
// nothing is wrong. A short bounded retry with backoff clears the race.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_RETRIES = 5;
const RENAME_BASE_MS = 20;
const TEMP_CREATE_RETRIES = 10;
const TEMP_RANDOM_BYTES = 16;

export function writeFileAtomic(destPath, payload) {
  mkdirSync(dirname(destPath), { recursive: true });
  const data = toBuffer(payload);
  let tmp = null;
  let fd = null;
  try {
    ({ path: tmp, fd } = openUniqueSiblingTemp(destPath));
    writeAll(fd, data);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, destPath);
    tmp = null;
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // preserve the original write/open/rename failure
      }
    }
    // Don't strand a half-written temp file (it would later be mistaken for a
    // user file inside a skill dir). Best-effort cleanup, then rethrow.
    try {
      if (tmp !== null) unlinkSync(tmp);
    } catch {
      // ignore — nothing more we can do
    }
    throw e;
  }
}

function toBuffer(payload) {
  if (typeof payload === 'string') return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return payload;
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError('writeFileAtomic: payload must be a string, Buffer, or ArrayBuffer view');
}

function openUniqueSiblingTemp(destPath) {
  const dir = dirname(destPath);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  let lastCollision = null;
  for (let attempt = 0; attempt < TEMP_CREATE_RETRIES; attempt++) {
    const token = randomBytes(TEMP_RANDOM_BYTES).toString('hex');
    const path = join(dir, `.cah-tmp-${process.pid}-${token}`);
    try {
      const fd = openSync(path, flags, 0o600);
      return { path, fd };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      lastCollision = e;
    }
  }
  throw lastCollision || new Error(`could not create unique atomic temp for ${destPath}`);
}

function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset);
    if (written === 0) throw new Error('writeFileAtomic: zero-byte write');
    offset += written;
  }
}

function renameWithRetry(from, to) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code)) throw e;
      // Exponential-ish backoff: 20, 40, 80, 160, 320 ms (cap).
      const delay = RENAME_BASE_MS * (1 << Math.min(attempt, 4));
      sleepSync(delay);
    }
  }
  throw lastErr;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — keeps this sync and zero-dep */ }
}

export function readFileMaybe(path) {
  try {
    return [true, readFileSync(path)];
  } catch (e) {
    if (e.code === 'ENOENT') return [false, null];
    throw e;
  }
}

// A path-based unlink has no conditional form: after a caller validates a
// file, another process can replace it before unlinkSync runs. Move the
// validated inode to an unpredictable sibling first, verify that the moved
// entry is still the same regular file, and only then unlink the sibling.
// A replacement is restored with a non-overwriting hard link where possible;
// if that is unavailable, leaving the unpredictable sibling is safer than
// risking an overwrite of a user's successor.
export function regularFileIdentity(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (!info.isFile()) return null;
  return info;
}

export function sameFileIdentity(left, right) {
  if (!left || !right || !left.isFile() || !right.isFile()) return false;
  // dev/ino identify the directory entry's inode. Include metadata that
  // changes for an in-place replacement so an edited managed file is also
  // treated as a successor when the filesystem exposes nanosecond timestamps.
  if (String(left.dev) !== String(right.dev) || String(left.ino) !== String(right.ino)) {
    return false;
  }
  // ctime is intentionally excluded: Windows updates it when the same inode
  // is moved to the quarantine name. mtime/size still catch ordinary
  // in-place edits, while dev/ino catch replacement files.
  return left.size === right.size
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs);
}

export function removeOwnedRegularFile(path, expected) {
  const current = regularFileIdentity(path);
  if (!sameFileIdentity(current, expected)) return false;

  const quarantine = uniqueSibling(path, '.cah-owned-remove-');
  try {
    renameSync(path, quarantine);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }

  const moved = regularFileIdentity(quarantine);
  if (!sameFileIdentity(moved, expected)) {
    restoreWithoutOverwrite(quarantine, path);
    return false;
  }
  unlinkSync(quarantine);
  return true;
}

export function removeEmptyDirectory(path) {
  try {
    rmdirSync(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST'
        || e.code === 'ENOTDIR' || e.code === 'EBUSY'
        || e.code === 'EPERM' || e.code === 'EACCES') return false;
    throw e;
  }
}

function uniqueSibling(path, prefix) {
  const dir = dirname(path);
  for (let attempt = 0; attempt < TEMP_CREATE_RETRIES; attempt++) {
    const candidate = join(dir, `${prefix}${process.pid}-${randomBytes(TEMP_RANDOM_BYTES).toString('hex')}`);
    try {
      lstatSync(candidate);
    } catch (e) {
      if (e.code === 'ENOENT') return candidate;
      throw e;
    }
  }
  throw new Error(`could not create unique removal name for ${path}`);
}

function restoreWithoutOverwrite(from, to) {
  // A hard link is an atomic no-replace restore on filesystems that support
  // it. If it is unavailable, keep `from` as a preserved entry rather than
  // allowing renameSync to overwrite a successor at `to`.
  try {
    linkSync(from, to);
    unlinkSync(from);
  } catch {
    // The moved entry remains in place and is therefore not lost.
  }
}

export function waitForTestInterlock(phase) {
  const base = process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK;
  if (process.env.CAH_TEST_ONLY !== '1'
      || !base || process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE !== phase) return;
  writeFileSync(`${base}.ready`, 'ready');
  const deadline = Date.now() + 10_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      lstatSync(`${base}.go`);
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`test interlock timed out for ${phase}`);
      }
      Atomics.wait(signal, 0, 0, Math.min(remaining, 50));
    }
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
    let children;
    try {
      children = readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    // Never resolve a link at the ownership marker path. Only a regular file
    // named exactly `manifestLeaf` can make this directory pruneable.
    const manifestEntry = children.find((child) => child.name === manifestLeaf);
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
    if (children.length !== 1) {
      preserved.push(entry.name);
      continue;
    }
    // Close the widest practical race before removing the manifest: if any
    // entry appeared or the manifest changed type, preserve the directory.
    const current = readdirSync(dirPath, { withFileTypes: true });
    if (current.length !== 1
        || current[0].name !== manifestLeaf
        || !current[0].isFile()) {
      preserved.push(entry.name);
      continue;
    }
    const finalManifest = regularFileIdentity(manifestPath);
    if (!sameFileIdentity(finalManifest, manifestAfter)) {
      preserved.push(entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-manifest-remove');
    if (!removeOwnedRegularFile(manifestPath, manifestAfter)) {
      preserved.push(entry.name);
      continue;
    }
    waitForTestInterlock('prune-before-rmdir');
    if (removeEmptyDirectory(dirPath)) pruned++;
    else preserved.push(entry.name);
  }
  return { pruned, preserved };
}
