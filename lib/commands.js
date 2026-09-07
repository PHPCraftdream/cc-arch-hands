import { join } from 'node:path';
import { AllModelCommands } from './manifest.js';
import { SentinelModelCommand, SetForModelCommand, classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, writeFileAtomic,
  removeOwnedRegularFile,
  normalizedRelativePath, stablePathExists,
  emptyMaintenanceReport, mergeMaintenanceReport,
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

export function writeModelCommands(_templates, scope, options = {}) {
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
      testInterlock: options.testInterlock,
    });
    written++;
  }

  const orphanReport = pruneOrphans(
    dir,
    new Set(AllModelCommands.map((mc) => `${mc.name}.md`)),
    SetForModelCommand, { testInterlock: options.testInterlock },
  );
  const recovery = [];
  const maintenance = emptyMaintenanceReport();
  mergeOrphanReport(skipped, recovery, dir, orphanReport, maintenance);
  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { written, skipped, recovery, pruned: orphanReport.pruned, maintenance };
}

export function removeModelCommands(scope, options = {}) {
  const dir = scope.resolveCommandsDir();
  let removed = 0;
  const skipped = [];
  const recovery = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `${mc.name}.md`);
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) continue;
    const ownership = classifyContent(snapshot.present, snapshot.content, SetForModelCommand);

    if (ownership === Ownership.foreign) {
      addUnique(skipped, normalizedRelativePath(dir, path));
      continue;
    }

    options.testInterlock?.('remove-before-owned-delete');
    const result = removeOwnedRegularFile(path, snapshot.expectedDestination,
      { testInterlock: options.testInterlock });
    if (result === true) removed++;
    else if (result?.preservedPath) {
      if (stablePathExists(path)) addUnique(skipped, normalizedRelativePath(dir, path));
      addUnique(recovery, normalizedRelativePath(dir, result.preservedPath));
    }
  }
  const orphanReport = pruneOrphans(
    dir,
    new Set(),
    SetForModelCommand, { testInterlock: options.testInterlock },
  );
  const maintenance = emptyMaintenanceReport();
  mergeOrphanReport(skipped, recovery, dir, orphanReport, maintenance);
  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { removed, skipped, recovery, pruned: orphanReport.pruned, maintenance };
}

function mergeOrphanReport(skipped, recovery, dir, report, maintenance = null) {
  for (const path of report.preserved) {
    addUnique(skipped, normalizedRelativePath(dir, path));
  }
  for (const path of report.recovery) {
    addUnique(recovery, normalizedRelativePath(dir, path));
  }
  if (maintenance) {
    mergeMaintenanceReport(maintenance, report.maintenance,
      (path) => normalizedRelativePath(dir, path));
  }
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}
