import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AllModelCommands } from './manifest.js';
import { SentinelModelCommand, SetForModelCommand, classifyContent, Ownership } from './sentinel.js';

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
    const [content, present] = readFileMaybe(path);
    const ownership = classifyContent(present, content, SetForModelCommand);

    if (ownership === Ownership.foreign) {
      skipped.push(path);
      continue;
    }

    writeFileSync(path, modelCommandBody(mc));
    written++;
  }
  return { written, skipped };
}

export function removeModelCommands(scope) {
  const dir = scope.resolveCommandsDir();
  let removed = 0;
  const skipped = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `${mc.name}.md`);
    const [content, present] = readFileMaybe(path);
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

export function readFileMaybe(path) {
  try {
    return [readFileSync(path), true];
  } catch (e) {
    if (e.code === 'ENOENT') return [null, false];
    throw e;
  }
}
