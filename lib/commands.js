import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AllModelCommands } from './manifest.js';
import { SentinelModelCommand, SetForModelCommand, classifyContent, Ownership } from './sentinel.js';
import { readFileMaybe, pruneOrphans, writeFileAtomic } from './fsutil.js';

const SENTINEL_BODY_GAP = 50;

function modelCommandBody(mc) {
  return (
    '---\n' +
    `description: ${mc.model} effort=${mc.effort}\n` +
    `model: ${mc.model}\n` +
    `effort: ${mc.effort}\n` +
    '---\n\n' +
    '$ARGUMENTS\n' +
    '\n'.repeat(SENTINEL_BODY_GAP) +
    SentinelModelCommand +
    '\n'
  );
}

export function writeModelCommands(_templates, scope) {
  const dir = scope.resolveCommandsDir();
  mkdirSync(dir, { recursive: true });

  let written = 0;
  const skipped = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `${mc.name}.md`);
    const [present, content] = readFileMaybe(path);
    const ownership = classifyContent(present, content, SetForModelCommand);

    if (ownership === Ownership.foreign) {
      skipped.push(path);
      continue;
    }

    writeFileAtomic(path, modelCommandBody(mc));
    written++;
  }

  const pruned = pruneOrphans(dir, new Set(AllModelCommands.map((mc) => `${mc.name}.md`)), SetForModelCommand);
  return { written, skipped, pruned };
}

export function removeModelCommands(scope) {
  const dir = scope.resolveCommandsDir();
  let removed = 0;
  const skipped = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `${mc.name}.md`);
    const [present, content] = readFileMaybe(path);
    const ownership = classifyContent(present, content, SetForModelCommand);

    if (ownership === Ownership.missing) continue;
    if (ownership === Ownership.foreign) {
      skipped.push(path);
      continue;
    }

    unlinkSync(path);
    removed++;
  }
  return { removed, skipped };
}
