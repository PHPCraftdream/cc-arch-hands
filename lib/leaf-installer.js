// leaf-installer.js — one flat directory of generated single-file artefacts
// (model commands, agents of every harness). Writes each entry that is ours or
// missing, never a foreign file, prunes owned orphans, and removes the same way.

import { join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, writeFileAtomic, removeOwnedRegularFile,
  normalizedRelativePath, stablePathExists,
  emptyMaintenanceReport, mergeMaintenanceReport, addUnique, mergeOrphanReport,
} from './fsutil.js';

function report(dir, expected, set, skipped, recovery, options) {
  const orphanReport = pruneOrphans(dir, expected, set, { testInterlock: options.testInterlock });
  const maintenance = emptyMaintenanceReport();
  mergeOrphanReport(skipped, recovery, dir, orphanReport, maintenance);
  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { skipped, recovery, pruned: orphanReport.pruned, maintenance };
}

// `leaves`: [{ leaf, body }], the complete set the directory should hold.
export function writeLeaves(dir, leaves, set, options = {}) {
  let written = 0;
  const skipped = [];
  for (const { leaf, body } of leaves) {
    const path = join(dir, leaf);
    const snapshot = captureRegularFileSnapshot(path);
    if (classifyContent(snapshot.present, snapshot.content, set) === Ownership.foreign) {
      addUnique(skipped, normalizedRelativePath(dir, path));
      continue;
    }
    writeFileAtomic(path, body, {
      expectedDestination: snapshot.expectedDestination,
      testInterlock: options.testInterlock,
    });
    written++;
  }
  return { written, ...report(dir, new Set(leaves.map(({ leaf }) => leaf)), set, skipped, [], options) };
}

// `leafNames`: the file names to remove; any other owned file goes as an orphan.
export function removeLeaves(dir, leafNames, set, options = {}) {
  let removed = 0;
  const skipped = [];
  const recovery = [];
  for (const leaf of leafNames) {
    const path = join(dir, leaf);
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) continue;
    if (classifyContent(snapshot.present, snapshot.content, set) === Ownership.foreign) {
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
  return { removed, ...report(dir, new Set(), set, skipped, recovery, options) };
}
