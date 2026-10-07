import { join } from 'node:path';
import { AllCodexAgents } from './manifest.js';
import { classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, pruneOrphans, writeFileAtomic,
  removeOwnedRegularFile,
  normalizedRelativePath, stablePathExists,
  emptyMaintenanceReport, mergeMaintenanceReport,
} from './fsutil.js';

export const OpencodeAgents = AllCodexAgents;
export const SentinelOpencodeAgent = '<!-- cah-opencode-agent:v1 -->';
export const SetForOpencodeAgent = { current: SentinelOpencodeAgent, legacy: [] };

function opencodeAgentBody(agent) {
  return `---
name: ${agent.name}
description: ${agent.display}. Invoke when the user requests ${agent.name}.
mode: subagent
model: openai/${agent.model}
options:
  reasoningEffort: ${agent.effort}
---

Выполни порученное задание полностью. Соблюдай ограничения пользователя.

${SentinelOpencodeAgent}
`;
}

export function writeOpencodeAgents(_templates, scope, options = {}) {
  const dir = scope.resolveAgentsDir();
  let written = 0;
  const skipped = [];

  for (const agent of OpencodeAgents) {
    const path = join(dir, `${agent.name}.md`);
    const snapshot = captureRegularFileSnapshot(path);
    const ownership = classifyContent(snapshot.present, snapshot.content, SetForOpencodeAgent);

    if (ownership === Ownership.foreign) {
      addUnique(skipped, normalizedRelativePath(dir, path));
      continue;
    }

    writeFileAtomic(path, opencodeAgentBody(agent), {
      expectedDestination: snapshot.expectedDestination,
      testInterlock: options.testInterlock,
    });
    written++;
  }

  const orphanReport = pruneOrphans(
    dir,
    new Set(OpencodeAgents.map((agent) => `${agent.name}.md`)),
    SetForOpencodeAgent, { testInterlock: options.testInterlock },
  );
  const recovery = [];
  const maintenance = emptyMaintenanceReport();
  mergeOrphanReport(skipped, recovery, dir, orphanReport, maintenance);
  mergeMaintenanceReport(maintenance, { recovery }, (path) => path);
  return { written, skipped, recovery, pruned: orphanReport.pruned, maintenance };
}

export function removeOpencodeAgents(scope, options = {}) {
  const dir = scope.resolveAgentsDir();
  let removed = 0;
  const skipped = [];
  const recovery = [];

  for (const agent of OpencodeAgents) {
    const path = join(dir, `${agent.name}.md`);
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) continue;
    const ownership = classifyContent(snapshot.present, snapshot.content, SetForOpencodeAgent);

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
    SetForOpencodeAgent, { testInterlock: options.testInterlock },
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
