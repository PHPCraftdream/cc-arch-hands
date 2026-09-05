import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AllSkills } from './manifest.js';
import { SentinelSkill, SetForSkill, classifyContent, Ownership } from './sentinel.js';
import { SKILL_MANIFEST_LEAF } from './scope.js';
import {
  readFileMaybe, pruneOrphanDirs, writeFileAtomic, regularFileIdentity,
  removeOwnedRegularFile, removeEmptyDirectory, waitForTestInterlock,
  captureDirectoryIdentities, directoryIdentitiesMatch,
} from './fsutil.js';

/**
 * Install skills under scope.resolveSkillsDir().
 *
 * options.subset — optional iterable of skill names to install. If provided,
 *   only those skills are written (foreign / unrelated existing skills are
 *   left untouched). If null/undefined, every name in AllSkills is installed.
 *   Names not in AllSkills are silently ignored at this layer (the CLI
 *   validates them upstream via parseOnly).
 *
 * Path operations use lstat plus parent-directory identity checks. This is
 * protection against malformed templates and ordinary same-user concurrency,
 * not a security boundary against a same-UID process that can replace a
 * parent in the check-to-operation gap; Node core has no portable openat-style
 * primitive. Callers must not concurrently replace managed ancestors while
 * an install is running.
 */
export function writeSkills(templates, scope, options = {}) {
  if (!templates) throw new Error('writeSkills: nil templates');
  const root = scope.resolveSkillsDir();

  const subset = options.subset
    ? new Set([...options.subset].filter((s) => AllSkills.includes(s)))
    : null;
  const names = subset ? [...subset] : AllSkills;
  // Validate every selected tree before touching the destination. This is
  // defense in depth for callers that bypass the CLI's install preflight.
  const trees = new Map(names.map((name) => {
    const destDir = resolve(root, name);
    assertContained(root, destDir, `skill ${name} destination`);
    return [name, validateSkillTree(templates, name, destDir)];
  }));

  let written = 0;
  const skipped = [];
  const preserved = [];
  const initialOwnership = new Map();

  // Determine foreign ownership from the manifest only. A foreign skill may
  // contain arbitrary user subtrees (including links); it is skipped without
  // inspecting them.
  assertSafeDestinationRoot(root);
  for (const name of names) {
    const destDir = resolve(root, name);
    assertSafePath(destDir, root, 'directory');
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    assertSafePath(manifestPath, root, 'file');
    const [present, content] = readFileMaybe(manifestPath);
    initialOwnership.set(name, classifyContent(present, content, SetForSkill));
  }

  // Do not let a bad managed destination turn into a partial install. Check
  // only paths that this invocation can write, after every selected template
  // tree has validated and before the first destination write.
  for (const name of names) {
    if (initialOwnership.get(name) === Ownership.foreign) continue;
    const destDir = resolve(root, name);
    for (const file of trees.get(name)) {
      const destination = resolve(destDir, file.relPath);
      assertContained(destDir, destination, `skill ${name}/${file.relPath}`);
      assertSafePath(destination, root, 'file');
    }
  }

  for (const name of names) {
    if (initialOwnership.get(name) === Ownership.foreign) {
      skipped.push(name);
      continue;
    }
    const destDir = resolve(root, name);
    assertSafePath(destDir, root, 'directory');
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    assertSafePath(manifestPath, root, 'file');
    const [present, content] = readFileMaybe(manifestPath);

    const ownership = classifyContent(present, content, SetForSkill);
    if (ownership === Ownership.foreign) {
      skipped.push(name);
      continue;
    }

    const files = trees.get(name);
    const ownedRel = new Set(files.map((f) => f.relPath));

    // Never wipe the whole directory: a user may have dropped their own notes
    // or patches alongside ours. Overwrite only the files we own (atomically)
    // and leave everything else untouched, recording it for the report.
    for (const rel of listUnexpectedEntries(destDir, ownedRel, root)) {
      preserved.push(`${name}/${rel}`);
    }

    for (const f of files) {
      const destination = resolve(destDir, f.relPath);
      assertContained(destDir, destination, `skill ${name}/${f.relPath}`);
      // Re-check all components immediately before handing the path to the
      // atomic writer. writeFileAtomic creates parents recursively, so make
      // those parents one safe component at a time first.
      ensureSafeDirectory(dirname(destination), root);
      assertSafePath(destination, root, 'file');
      const parentIdentities = captureManagedParentIdentities(destination, root);
      waitForTestInterlock('write-before-owned-write');
      assertManagedParentIdentities(parentIdentities);

      let payload = Buffer.from(f.bytes);
      if (f.relPath === SKILL_MANIFEST_LEAF) {
        if (!payload.includes(Buffer.from(SentinelSkill))) {
          payload = Buffer.concat([payload, Buffer.from(`\n${SentinelSkill}\n`)]);
        }
      }
      writeFileAtomic(destination, payload, {
        createParents: false,
        parentIdentities,
      });
    }
    written++;
  }

  const { pruned, preserved: prunedKept } = pruneOrphanDirs(
    root, new Set(AllSkills), SKILL_MANIFEST_LEAF, SetForSkill,
  );
  for (const n of prunedKept) preserved.push(`${n}/ (orphan dir with user files)`);
  return { written, skipped, pruned, preserved };
}

/**
 * Return a skill's files only when its template has one unambiguous, regular
 * root manifest. The root name is deliberately case-sensitive: `skill.md` or
 * `foo/SKILL.md` must not be allowed to stand in for `SKILL.md`.
 *
 * Templates from disk expose their root directory, so lstat is used there to
 * reject a directory or symlink at the manifest path. Lightweight template
 * providers may expose only the file list; in that case the exact relPath and
 * duplicate checks are the strongest guarantees their API permits.
 */
export function validateSkillTree(templates, name, destDir = null) {
  const files = templates.skillTree(name);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`skill ${name}: empty template tree`);
  }

  const seen = new Set();
  const seenPortable = new Set();
  let rootCount = 0;
  for (const file of files) {
    if (!file || typeof file.relPath !== 'string' || file.relPath.length === 0) {
      throw new Error(`skill ${name}: template tree contains a file with no relPath`);
    }
    if (seen.has(file.relPath)) {
      throw new Error(`skill ${name}: duplicate template relPath ${file.relPath}`);
    }

    validateRelPath(file.relPath, name);
    if (!Buffer.isBuffer(file.bytes) && !(file.bytes instanceof Uint8Array)) {
      throw new Error(`skill ${name}: template file ${file.relPath} bytes must be Buffer or Uint8Array`);
    }

    // The destination is also used on case-insensitive filesystems. Reject
    // collisions such as SKILL.md + skill.md instead of letting one silently
    // overwrite the other. Prefixes are checked too, since `a` and `a/b`
    // cannot coexist as a file tree on any supported filesystem.
    const portableParts = file.relPath.split('/').map((part) =>
      part.normalize('NFC').toLowerCase());
    const portable = portableParts.join('/');
    if (seenPortable.has(portable)
        || [...seenPortable].some((other) =>
          other.startsWith(`${portable}/`) || portable.startsWith(`${other}/`))) {
      throw new Error(`skill ${name}: colliding template relPath ${file.relPath}`);
    }
    seen.add(file.relPath);
    seenPortable.add(portable);
    if (file.relPath === SKILL_MANIFEST_LEAF) rootCount++;

    if (destDir !== null) {
      const destination = resolve(destDir, file.relPath);
      assertContained(destDir, destination, `skill ${name}/${file.relPath}`);
    }
  }

  if (rootCount !== 1) {
    throw new Error(
      `skill ${name}: template tree must contain exactly one root ${SKILL_MANIFEST_LEAF}`,
    );
  }

  if (typeof templates.root === 'string') {
    const sourceManifest = join(templates.root, 'skills', name, SKILL_MANIFEST_LEAF);
    let info;
    try {
      info = lstatSync(sourceManifest);
    } catch {
      throw new Error(`skill ${name}: root ${SKILL_MANIFEST_LEAF} must be a regular file`);
    }
    if (!info.isFile()) {
      throw new Error(`skill ${name}: root ${SKILL_MANIFEST_LEAF} must be a regular file`);
    }
  }

  return files;
}

function validateRelPath(relPath, name) {
  if (relPath.includes('\0')) {
    throw new Error(`skill ${name}: template relPath contains NUL`);
  }
  const hasSlash = relPath.includes('/');
  const hasBackslash = relPath.includes('\\');
  if (hasSlash && hasBackslash) {
    throw new Error(`skill ${name}: template relPath uses mixed separators: ${relPath}`);
  }
  // A backslash-only path is not portable: it is a separator on Windows but
  // an ordinary filename character on Unix. Templates use forward slashes.
  if (hasBackslash) {
    throw new Error(`skill ${name}: template relPath uses Windows separators: ${relPath}`);
  }
  if (relPath.startsWith('/') || isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)
      || relPath.startsWith('//') || relPath.startsWith('\\')) {
    throw new Error(`skill ${name}: template relPath must be relative: ${relPath}`);
  }

  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`skill ${name}: template relPath contains an invalid segment: ${relPath}`);
    }
    // Windows strips these characters from the end of a path component.
    if (/[. ]$/.test(segment)) {
      throw new Error(`skill ${name}: template relPath has a trailing dot/space alias: ${relPath}`);
    }
    // Keep alternate data streams and other Windows-only spellings out of a
    // tree that must have the same meaning on Unix and Windows.
    if (/[<>:"|?*]/.test(segment)) {
      throw new Error(`skill ${name}: template relPath has invalid Windows characters: ${relPath}`);
    }
    if (isWindowsDeviceSegment(segment)) {
      throw new Error(`skill ${name}: template relPath uses a Windows device name: ${relPath}`);
    }
  }
}

function isWindowsDeviceSegment(segment) {
  const base = segment.split('.')[0];
  return /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])$/i.test(base)
    || /^(?:com|lpt)[¹²³]$/i.test(base);
}

function assertContained(base, target, label, allowEqual = false) {
  const baseAbs = resolve(base);
  const targetAbs = resolve(target);
  const rel = relative(baseAbs, targetAbs);
  if ((!allowEqual && rel === '') || rel === '..' || rel.startsWith(`..${sep}`)
      || isAbsolute(rel)) {
    throw new Error(`${label} escapes its destination directory`);
  }
}

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function assertSafeDestinationRoot(root) {
  const rootAbs = resolve(root);
  const scopeRoot = dirname(rootAbs);
  assertSafePath(rootAbs, scopeRoot, 'directory');
  // `root` is normally <scope>/.claude/skills. A symlink at .claude would
  // redirect the entire destination, even though root itself might not yet
  // exist. Check that direct parent as well, but do not impose a policy on
  // unrelated ancestors such as a symlinked home directory.
  const info = lstatMaybe(scopeRoot);
  if (info && info.isSymbolicLink()) {
    throw new Error(`destination root parent is a symlink: ${scopeRoot}`);
  }
  if (info && !info.isDirectory()) {
    throw new Error(`destination root parent is not a directory: ${scopeRoot}`);
  }
}

function assertSafePath(path, anchor, kind) {
  const target = resolve(path);
  if (anchor !== null) assertContained(anchor, target, 'destination path', true);
  const anchorInfo = anchor === null ? null : lstatMaybe(anchor);

  let cursor = target;
  while (true) {
    const info = lstatMaybe(cursor);
    if (info) {
      if (cursor === target) {
        if (kind === 'directory' && !info.isDirectory()) {
          throw new Error(`destination directory is not a directory: ${target}`);
        }
        if (kind === 'file' && !info.isFile()) {
          throw new Error(`destination file is not a regular file: ${target}`);
        }
      } else if (!info.isDirectory()) {
        throw new Error(`destination path component is not a directory: ${cursor}`);
      }
      if (info.isSymbolicLink()) {
        throw new Error(`destination path contains a symlink: ${cursor}`);
      }
      if (anchorInfo && isWithin(anchor, cursor)) {
        const anchorReal = realpathSync.native(resolve(anchor));
        const cursorReal = realpathSync.native(cursor);
        if (!isWithin(anchorReal, cursorReal)) {
          throw new Error(`destination path contains a junction/reparse traversal: ${cursor}`);
        }
      }
      if (anchor !== null && samePath(cursor, anchor)) return;
      // Once a missing destination has reached an existing ancestor and the
      // anchor itself is absent, the remaining ancestors are outside the
      // destination contract. Otherwise continue to check every component
      // down to the anchor (a symlink can be below an otherwise safe parent).
      if (anchor !== null && anchorInfo === null) return;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function ensureSafeDirectory(path, anchor) {
  const target = resolve(path);
  if (anchor !== null) assertContained(anchor, target, 'destination path');

  const missing = [];
  let cursor = target;
  while (lstatMaybe(cursor) === null) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (anchor === null || lstatMaybe(anchor) !== null) {
    assertSafePath(cursor, anchor, 'directory');
  } else {
    assertSafePath(cursor, null, 'directory');
  }
  let anchorReady = anchor === null || lstatMaybe(anchor) !== null;
  for (const dir of missing.reverse()) {
    mkdirSync(dir);
    assertSafePath(dir, anchorReady ? anchor : null, 'directory');
    if (anchor !== null && samePath(dir, anchor)) anchorReady = true;
  }
  assertSafePath(target, anchor, 'directory');
}

function listUnexpectedEntries(dir, ownedRel, anchor) {
  if (lstatMaybe(dir) === null) return [];
  const expectedDirs = new Set();
  for (const relPath of ownedRel) {
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      expectedDirs.add(parts.slice(0, i).join('/'));
    }
  }

  const extras = [];
  const walkExpected = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (ownedRel.has(childRel)) continue;
      if (!expectedDirs.has(childRel)) {
        // Unknown files, directories, and links are user data. Record the
        // entry itself and never descend into it or resolve its target.
        extras.push(childRel);
        continue;
      }

      const child = join(abs, entry.name);
      // This directory is a parent of an expected managed file, so its path
      // is in scope for traversal safety and must be a real directory.
      assertSafePath(child, anchor, 'directory');
      walkExpected(child, childRel);
    }
  };
  walkExpected(dir, '');
  return extras;
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isWithin(base, target) {
  const baseAbs = resolve(base);
  const targetAbs = resolve(target);
  const rel = relative(baseAbs, targetAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel));
}

/**
 * Remove skills under scope.resolveSkillsDir().
 *
 * options.subset — optional iterable of skill names to remove. If provided,
 *   only those skills are removed (other installed skills are left in place).
 *   If null/undefined, every name in AllSkills is removed.
 *
 * `templates` is required (same as writeSkills) so a multi-file skill's OWN
 * files (e.g. an assets/ subtree) are recognized as ours via
 * templates.skillTree(name) — not lumped in with genuinely foreign
 * user-added files. Before this, any file besides SKILL.md was treated as a
 * user addition, so a multi-file skill only ever lost its manifest sentinel
 * on removal and its other files (and the directory) lingered forever; this
 * was latent because every skill happened to be SKILL.md-only until one
 * shipped a companion script.
 *
 * Removal uses lstat, inode identities, and managed parent-directory identity
 * checks around each path operation. This is fail-safe for ordinary
 * same-user concurrency, but is not a security boundary against a same-UID
 * process that deliberately swaps a parent in the final check-to-operation
 * gap. Callers must not concurrently replace managed ancestors while removal
 * is running; Node core has no portable openat-style primitive.
 */
export function removeSkills(templates, scope, options = {}) {
  if (!templates) throw new Error('removeSkills: nil templates');
  const root = scope.resolveSkillsDir();
  const subset = options.subset
    ? new Set([...options.subset].filter((s) => AllSkills.includes(s)))
    : null;
  const names = subset ? [...subset] : AllSkills;

  let removed = 0;
  const skipped = [];
  const preserved = [];
  const managed = [];

  // Resolve ownership without mutating anything first. Missing and foreign
  // skills do not require a corresponding template tree, preserving the
  // library's existing no-op/skip semantics.
  assertSafeDestinationRoot(root);
  for (const name of names) {
    const destDir = resolve(root, name);
    assertContained(root, destDir, `skill ${name} destination`);
    assertSafePath(destDir, root, 'directory');
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    assertSafePath(manifestPath, root, 'file');
    const [present, content] = readFileMaybe(manifestPath);
    const ownership = classifyContent(present, content, SetForSkill);
    if (ownership === Ownership.foreign) skipped.push(name);
    if (ownership === Ownership.mine || ownership === Ownership.legacy) managed.push(name);
  }

  // Library callers do not necessarily pass through the CLI preflight.
  // Validate every tree that can remove data, plus every resolved destination
  // component, before the first deletion from any skill.
  const trees = new Map(managed.map((name) => {
    const destDir = resolve(root, name);
    return [name, validateSkillTree(templates, name, destDir)];
  }));
  for (const name of managed) {
    const destDir = resolve(root, name);
    for (const file of trees.get(name)) {
      const destination = resolve(destDir, file.relPath);
      assertContained(destDir, destination, `skill ${name}/${file.relPath}`);
      assertSafePath(destination, root, 'file');
    }
  }

  for (const name of managed) {
    const destDir = resolve(root, name);
    assertSafePath(destDir, root, 'directory');
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    assertSafePath(manifestPath, root, 'file');
    const [present, content] = readFileMaybe(manifestPath);
    const ownership = classifyContent(present, content, SetForSkill);
    if (ownership === Ownership.missing) continue;
    if (ownership === Ownership.foreign) {
      if (!skipped.includes(name)) skipped.push(name);
      continue;
    }

    const files = trees.get(name);
    const ownedRel = new Set(files.map((f) => f.relPath));

    // If the user added files we don't recognize as ours, remove only what
    // we own (including the manifest) and leave their files — and the
    // directory — in place rather than nuking the tree. Such a skill is
    // reported under `preserved`, NOT `removed`: the directory survives, so
    // counting it as removed would mislead.
    const extras = listUnexpectedEntries(destDir, ownedRel, root);
    const snapshots = captureOwnedFiles(destDir, ownedRel, root);
    if (extras.length > 0) {
      waitForTestInterlock('remove-before-owned-delete');
      removeCapturedFiles(destDir, snapshots, root);
      preserved.push(name);
    } else {
      waitForTestInterlock('remove-before-owned-delete');
      removeCapturedFiles(destDir, snapshots, root);
      waitForTestInterlock('remove-before-rmdir');
      const expectedDirs = expectedParentDirs(ownedRel);
      for (const rel of [...expectedDirs].sort((a, b) => b.length - a.length)) {
        const parent = resolve(destDir, rel);
        assertContained(destDir, parent, `skill ${name}/${rel}`);
        // This is the cleanup phase. lstat-based rmdir never follows a
        // replacement link, and treating its type/race errors as preserve
        // keeps a concurrently replaced parent from becoming a hard failure.
        const parentIdentities = captureManagedParentIdentities(parent, root, true);
        if (parentIdentities !== null && directoryIdentitiesMatch(parentIdentities)) {
          removeEmptyDirectory(parent, { parentIdentities });
        }
      }
      const skillIdentities = captureManagedParentIdentities(destDir, root, true);
      if (skillIdentities !== null && directoryIdentitiesMatch(skillIdentities)
          && removeEmptyDirectory(destDir, { parentIdentities: skillIdentities })) removed++;
      else preserved.push(name);
    }
  }
  return { removed, skipped, preserved };
}

function expectedParentDirs(ownedRel) {
  const dirs = new Set();
  for (const rel of ownedRel) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

function captureOwnedFiles(destDir, ownedRel, root) {
  const snapshots = new Map();
  for (const rel of ownedRel) {
    const destination = resolve(destDir, rel);
    assertContained(destDir, destination, `skill file ${rel}`);
    assertSafePath(destination, root, 'file');
    const identity = regularFileIdentity(destination);
    if (identity) snapshots.set(rel, identity);
  }
  return snapshots;
}

function captureManagedParentIdentities(path, root, includeSelf = false) {
  const target = resolve(path);
  const rootAbs = resolve(root);
  const paths = [];
  let cursor = includeSelf ? target : dirname(target);
  while (isWithin(rootAbs, cursor)) {
    paths.push(cursor);
    if (samePath(cursor, rootAbs)) break;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  if (paths.length === 0 || !samePath(paths.at(-1), rootAbs)) return null;
  return captureDirectoryIdentities(paths);
}

function assertManagedParentIdentities(snapshot) {
  if (!directoryIdentitiesMatch(snapshot)) {
    throw new Error('managed skill parent changed concurrently; refusing operation');
  }
}

function removeCapturedFiles(destDir, snapshots, root) {
  for (const [rel, identity] of snapshots) {
    const path = resolve(destDir, rel);
    const parentIdentities = captureManagedParentIdentities(path, root);
    if (parentIdentities === null || !directoryIdentitiesMatch(parentIdentities)) continue;
    removeOwnedRegularFile(path, identity, { parentIdentities });
  }
}
