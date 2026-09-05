import { join } from 'node:path';
import { AllModelCommands } from './manifest.js';
import { SentinelModelCommand, SetForModelCommand, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, readFileMaybe, pruneOrphans, writeFileAtomic, regularFileIdentity,
  sameFileIdentity, removeOwnedRegularFile, waitForTestInterlock,
  normalizedRelativePath,
} from './fsutil.js';

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
    const snapshot = captureRegularFileSnapshot(path);
    const ownership = classifyContent(snapshot.present, snapshot.content, SetForModelCommand);

    if (ownership === Ownership.foreign) {
      addUnique(skipped, normalizedRelativePath(dir, path));
      continue;
    }

    writeFileAtomic(path, modelCommandBody(mc), {
      expectedDestination: snapshot.expectedDestination,
    });
    written++;
  }

  const orphanReport = pruneOrphans(
    dir,
    new Set(AllModelCommands.map((mc) => `${mc.name}.md`)),
    SetForModelCommand,
  );
  mergeOrphanReport(skipped, dir, orphanReport);
  return { written, skipped, pruned: orphanReport.pruned };
}

export function removeModelCommands(scope) {
  const dir = scope.resolveCommandsDir();
  let removed = 0;
  const skipped = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `${mc.name}.md`);
    const observed = regularFileIdentity(path);
    if (!observed) continue;
    const [present, content] = readFileMaybe(path);
    const afterRead = regularFileIdentity(path);
    if (!sameFileIdentity(observed, afterRead)) continue;
    const ownership = classifyContent(present, content, SetForModelCommand);

    if (ownership === Ownership.missing) continue;
    if (ownership === Ownership.foreign) {
      addUnique(skipped, normalizedRelativePath(dir, path));
      continue;
    }

    waitForTestInterlock('remove-before-owned-delete');
    const result = removeOwnedRegularFile(path, afterRead);
    if (result === true) removed++;
    else if (result?.preservedPath) {
      addUnique(skipped, normalizedRelativePath(dir, result.preservedPath));
    }
  }
  const orphanReport = pruneOrphans(
    dir,
    new Set(),
    SetForModelCommand,
  );
  mergeOrphanReport(skipped, dir, orphanReport);
  return { removed, skipped, pruned: orphanReport.pruned };
}

function mergeOrphanReport(skipped, dir, report) {
  for (const path of report.preserved) {
    addUnique(skipped, normalizedRelativePath(dir, path));
  }
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}
