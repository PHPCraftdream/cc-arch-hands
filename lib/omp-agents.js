import { join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';
import { OmpAgents, SetForOmpAgent, SentinelOmpAgent } from './omp-scope.js';
import {
  captureRegularFileSnapshot, pruneOrphans, writeFileAtomic,
  removeOwnedRegularFile,
  normalizedRelativePath, stablePathExists,
  emptyMaintenanceReport, mergeMaintenanceReport,
} from './fsutil.js';

function ompAgentBody(agent) {
  return `---
name: ${agent.name}
description: ${agent.display}. Invoke when the user requests ${agent.name}.
model: openai-codex/${agent.model}
thinking-level: ${agent.effort}
---

Выполни порученное задание полностью. Соблюдай ограничения пользователя.

${SentinelOmpAgent}
`;
}

export function writeOmpAgents(_templates, scope, options = {}) {
  const dir = scope.resolveAgentsDir();
  let written = 0;
  const skipped = [];

  for (const agent of OmpAgents) {
    const path = join(dir, `${agent.name}.md`);
    const snapshot = captureRegularFileSnapshot(path);
    const ownership = classifyContent(snapshot.present, snapshot.content, SetForOmpAgent);

    if (ownership === Ownership.foreign) {
      addUnique(skipped, normalizedRelativePath(dir, path));
      continue;
    }

    writeFileAtomic(path, ompAgentBody(agent), {
      expectedDestination: snapshot.expectedDestination,
      testInterlock: options.testInterlock,
    });
    written++;
  }

  const orphanReport = pruneOrphans(
    dir,
    new Set(OmpAgents.map((agent) => `${agent.name}.md`)),
    SetForOmpAgent, { testInterlock: options.testInterlock },
  );
  const recovery = [];
  const maintenance = emptyMaintenanceReport();
  mergeOrphanReport(skipped, recovery, dir, orphanReport, maintenance);
  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { written, skipped, recovery, pruned: orphanReport.pruned, maintenance };
}

export function removeOmpAgents(scope, options = {}) {
  const dir = scope.resolveAgentsDir();
  let removed = 0;
  const skipped = [];
  const recovery = [];

  for (const agent of OmpAgents) {
    const path = join(dir, `${agent.name}.md`);
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) continue;
    const ownership = classifyContent(snapshot.present, snapshot.content, SetForOmpAgent);

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
    SetForOmpAgent, { testInterlock: options.testInterlock },
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
