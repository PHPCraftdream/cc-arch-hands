import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { AllSkills } from './manifest.js';
import { SentinelSkill, SetForSkill, classifyContent, Ownership } from './sentinel.js';
import { SKILL_MANIFEST_LEAF } from './scope.js';
import { readFileMaybe, listFilesRel, pruneOrphanDirs, writeFileAtomic } from './fsutil.js';

/**
 * Install skills under scope.resolveSkillsDir().
 *
 * options.subset — optional iterable of skill names to install. If provided,
 *   only those skills are written (foreign / unrelated existing skills are
 *   left untouched). If null/undefined, every name in AllSkills is installed.
 *   Names not in AllSkills are silently ignored at this layer (the CLI
 *   validates them upstream via parseOnly).
 */
export function writeSkills(templates, scope, options = {}) {
  if (!templates) throw new Error('writeSkills: nil templates');
  const root = scope.resolveSkillsDir();

  const subset = options.subset
    ? new Set([...options.subset].filter((s) => AllSkills.includes(s)))
    : null;
  const names = subset ? [...subset] : AllSkills;

  let written = 0;
  const skipped = [];
  const preserved = [];

  for (const name of names) {
    const destDir = join(root, name);
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    const [present, content] = readFileMaybe(manifestPath);

    const ownership = classifyContent(present, content, SetForSkill);
    if (ownership === Ownership.foreign) {
      skipped.push(name);
      continue;
    }

    const files = templates.skillTree(name);
    if (files.length === 0) throw new Error(`skill ${name}: empty template tree`);
    const ownedRel = new Set(files.map((f) => f.relPath));

    // Never wipe the whole directory: a user may have dropped their own notes
    // or patches alongside ours. Overwrite only the files we own (atomically)
    // and leave everything else untouched, recording it for the report.
    for (const rel of listFilesRel(destDir)) {
      if (!ownedRel.has(rel)) preserved.push(`${name}/${rel}`);
    }

    for (const f of files) {
      let payload = f.bytes;
      if (f.relPath === SKILL_MANIFEST_LEAF) {
        if (!payload.includes(SentinelSkill)) {
          payload = Buffer.concat([payload, Buffer.from(`\n${SentinelSkill}\n`)]);
        }
      }
      writeFileAtomic(join(destDir, f.relPath), payload);
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

  for (const name of names) {
    const destDir = join(root, name);
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    const [present, content] = readFileMaybe(manifestPath);

    const ownership = classifyContent(present, content, SetForSkill);
    if (ownership === Ownership.missing) continue;
    if (ownership === Ownership.foreign) {
      skipped.push(name);
      continue;
    }

    const files = templates.skillTree(name);
    const ownedRel = new Set(files.map((f) => f.relPath));

    // If the user added files we don't recognize as ours, remove only what
    // we own (including the manifest) and leave their files — and the
    // directory — in place rather than nuking the tree. Such a skill is
    // reported under `preserved`, NOT `removed`: the directory survives, so
    // counting it as removed would mislead.
    const extras = listFilesRel(destDir).filter((rel) => !ownedRel.has(rel));
    if (extras.length > 0) {
      for (const rel of ownedRel) rmSync(join(destDir, rel), { force: true });
      preserved.push(name);
    } else {
      rmSync(destDir, { recursive: true, force: true });
      removed++;
    }
  }
  return { removed, skipped, preserved };
}
