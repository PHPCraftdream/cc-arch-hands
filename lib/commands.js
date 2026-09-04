import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AllModelCommands } from './manifest.js';
import { SentinelModelCommand, SetForModelCommand, classifyContent, Ownership } from './sentinel.js';
import { readFileMaybe, pruneOrphans, writeFileAtomic } from './fsutil.js';

const SENTINEL_BODY_GAP = 50;

function modelCommandBody(mc) {
  const effort = mc.effort == null ? '' : `effort: ${mc.effort}\n`;
  const description = mc.effort == null ? mc.model : `${mc.model} effort=${mc.effort}`;
  return (
    '---\n' +
    `description: ${description}\n` +
    `model: ${mc.model}\n` +
    effort +
    '---\n\n' +
    '(Switches this turn\'s model/effort — not a request to launch an Agent.)\n\n' +
    '$ARGUMENTS\n' +
    '\n'.repeat(SENTINEL_BODY_GAP) +
    SentinelModelCommand +
    '\n'
  );
}

export function writeModelCommands(_templates, scope) {
  const dir = scope.resolveCommandsDir();
  // resolveCommandsDir() applies the strict-scope guard; writeFileAtomic
  // creates the directory on first write.

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
  const pruned = pruneOrphans(dir, new Set(), SetForModelCommand);
  return { removed, skipped, pruned };
}
