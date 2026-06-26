import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AllSkills } from './manifest.js';
import { SentinelSkill, SetForSkill, classifyContent, Ownership } from './sentinel.js';
import { SKILL_MANIFEST_LEAF } from './scope.js';
import { readFileMaybe, pruneOrphanDirs } from './fsutil.js';

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

  for (const name of names) {
    const destDir = join(root, name);
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    const [present, content] = readFileMaybe(manifestPath);

    const ownership = classifyContent(present, content, SetForSkill);
    if (ownership === Ownership.foreign) {
      skipped.push(name);
      continue;
    }
    if (ownership === Ownership.mine || ownership === Ownership.legacy) {
      rmSync(destDir, { recursive: true, force: true });
    }

    const files = templates.skillTree(name);
    if (files.length === 0) throw new Error(`skill ${name}: empty template tree`);

    for (const f of files) {
      const destPath = join(destDir, f.relPath);
      mkdirSync(dirname(destPath), { recursive: true });

      let payload = f.bytes;
      if (f.relPath === SKILL_MANIFEST_LEAF) {
        if (!payload.includes(SentinelSkill)) {
          payload = Buffer.concat([payload, Buffer.from(`\n${SentinelSkill}\n`)]);
        }
      }
      writeFileSync(destPath, payload);
    }
    written++;
  }

  const pruned = pruneOrphanDirs(root, new Set(AllSkills), SKILL_MANIFEST_LEAF, SetForSkill);
  return { written, skipped, pruned };
}

/**
 * Remove skills under scope.resolveSkillsDir().
 *
 * options.subset — optional iterable of skill names to remove. If provided,
 *   only those skills are removed (other installed skills are left in place).
 *   If null/undefined, every name in AllSkills is removed.
 */
export function removeSkills(scope, options = {}) {
  const root = scope.resolveSkillsDir();
  const subset = options.subset
    ? new Set([...options.subset].filter((s) => AllSkills.includes(s)))
    : null;
  const names = subset ? [...subset] : AllSkills;

  let removed = 0;
  const skipped = [];

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

    rmSync(destDir, { recursive: true, force: true });
    removed++;
  }
  return { removed, skipped };
}
