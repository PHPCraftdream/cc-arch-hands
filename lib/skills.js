import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AllSkills } from './manifest.js';
import { SentinelSkill, SetForSkill, classifyContent, Ownership } from './sentinel.js';
import { SKILL_MANIFEST_LEAF } from './scope.js';

export function writeSkills(templates, scope) {
  if (!templates) throw new Error('writeSkills: nil templates');
  const root = scope.resolveSkillsDir();

  let written = 0;
  const skipped = [];

  for (const name of AllSkills) {
    const destDir = join(root, name);
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    const [present, content] = readIfPresent(manifestPath);

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
      if (f.relPath === SKILL_MANIFEST_LEAF || f.relPath === 'SKILL.md') {
        if (!payload.includes(SentinelSkill)) {
          payload = Buffer.concat([payload, Buffer.from(`\n${SentinelSkill}\n`)]);
        }
      }
      writeFileSync(destPath, payload);
    }
    written++;
  }
  return { written, skipped };
}

export function removeSkills(scope) {
  const root = scope.resolveSkillsDir();
  let removed = 0;
  const skipped = [];

  for (const name of AllSkills) {
    const destDir = join(root, name);
    const manifestPath = join(destDir, SKILL_MANIFEST_LEAF);
    const [present, content] = readIfPresent(manifestPath);

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

function readIfPresent(path) {
  try {
    return [true, readFileSync(path)];
  } catch (e) {
    if (e.code === 'ENOENT') return [false, null];
    throw e;
  }
}
