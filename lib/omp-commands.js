import { join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, writeFileAtomic, removeOwnedRegularFile, pruneOrphans,
  normalizedRelativePath, stablePathExists, emptyMaintenanceReport, mergeMaintenanceReport,
} from './fsutil.js';

export const OmpCommands = [
  'checkpoint', 'ccheckpoint', 'checkpoint-resume', 'checkpoint-prune',
  'babysit', 'babygoal', 'task', 'triage', 'repo-sight',
];
export const SetForOmpCommand = { current: '<!-- cah-omp-command:v1 -->', legacy: [] };
export const SetForOmpCommandRuntime = { current: '// cah-omp-command-runtime:v1', legacy: [] };
export const OmpCommandRuntimeFiles = [
  'cah/commit-checkpoint.mjs', 'extensions/cah-babysit.js',
];

function templateLeaf(templates, name, kind, leaf) {
  const files = templates.skillTree(name, kind);
  const file = files.find((entry) => entry.relPath === leaf);
  if (!file || !file.bytes.length) throw new Error(`OMP ${name}: missing or empty ${leaf} template`);
  return file.bytes.toString('utf8');
}

export function prepareOmpCommands(templates, scope) {
  const root = scope.agentRoot();
  const helper = join(root, OmpCommandRuntimeFiles[0]);
  const files = [
    { rel: OmpCommandRuntimeFiles[0], set: SetForOmpCommandRuntime,
      body: `${templateLeaf(templates, 'ccheckpoint', 'codex-skills', 'scripts/commit-checkpoint.mjs')}\n${SetForOmpCommandRuntime.current}\n` },
    { rel: OmpCommandRuntimeFiles[1], set: SetForOmpCommandRuntime,
      body: templateLeaf(templates, 'runtime', 'omp-commands', 'babysit.js') },
  ];
  for (const name of OmpCommands) {
    const body = templateLeaf(templates, name, 'omp-commands', 'command.md');
    if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(body)) {
      throw new Error(`OMP ${name}: command template needs YAML frontmatter`);
    }
    files.push({ rel: `commands/${name}.md`, set: SetForOmpCommand,
      body: `${body.replaceAll('{{COMMIT_HELPER}}', JSON.stringify(helper))}\n${SetForOmpCommand.current}\n` });
  }
  for (const file of files.slice(0, OmpCommandRuntimeFiles.length)) {
    if (!file.body.includes(file.set.current)) throw new Error(`OMP ${file.rel}: missing runtime sentinel`);
    const snapshot = captureRegularFileSnapshot(join(root, file.rel));
    if (classifyContent(snapshot.present, snapshot.content, file.set) === Ownership.foreign) {
      throw new Error(`OMP command runtime is foreign; refusing to overwrite: ${join(root, file.rel)}`);
    }
  }
  return files;
}

export function writeOmpCommands(templates, scope, options = {}) {
  const files = prepareOmpCommands(templates, scope);
  const root = scope.agentRoot();
  let written = 0;
  const skipped = [];
  for (const file of files) {
    const path = join(root, file.rel);
    const snapshot = captureRegularFileSnapshot(path);
    if (classifyContent(snapshot.present, snapshot.content, file.set) === Ownership.foreign) {
      if (file.set === SetForOmpCommandRuntime) throw new Error(`OMP command runtime became foreign: ${path}`);
      skipped.push(file.rel);
      continue;
    }
    writeFileAtomic(path, file.body, {
      expectedDestination: snapshot.expectedDestination, testInterlock: options.testInterlock,
    });
    written++;
  }
  return finish(root, { written, skipped, recovery: [] },
    new Set(OmpCommands.map((name) => `${name}.md`)), options);
}

export function removeOmpCommands(scope, options = {}) {
  const root = scope.agentRoot();
  let removed = 0;
  const skipped = [];
  const recovery = [];
  const files = [
    ...OmpCommands.map((name) => ({ rel: `commands/${name}.md`, set: SetForOmpCommand })),
    ...OmpCommandRuntimeFiles.map((rel) => ({ rel, set: SetForOmpCommandRuntime })),
  ];
  for (const file of files) {
    const path = join(root, file.rel);
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) continue;
    if (classifyContent(snapshot.present, snapshot.content, file.set) === Ownership.foreign) {
      skipped.push(file.rel);
      continue;
    }
    const result = removeOwnedRegularFile(path, snapshot.expectedDestination,
      { testInterlock: options.testInterlock });
    if (result === true) removed++;
    else if (result?.preservedPath) {
      if (stablePathExists(path)) skipped.push(file.rel);
      recovery.push(normalizedRelativePath(root, result.preservedPath));
    }
  }
  return finish(root, { removed, skipped, recovery }, new Set(), options);
}

function finish(root, result, expected, options) {
  const report = pruneOrphans(join(root, 'commands'), expected, SetForOmpCommand,
    { testInterlock: options.testInterlock });
  for (const path of report.preserved) {
    const rel = normalizedRelativePath(root, path);
    if (!result.skipped.includes(rel)) result.skipped.push(rel);
  }
  for (const path of report.recovery) {
    const rel = normalizedRelativePath(root, path);
    if (!result.recovery.includes(rel)) result.recovery.push(rel);
  }
  const maintenance = emptyMaintenanceReport();
  mergeMaintenanceReport(maintenance, report.maintenance,
    (path) => normalizedRelativePath(root, path));
  mergeMaintenanceReport(maintenance, { recovery: result.recovery }, (path) => path);
  return { ...result, pruned: report.pruned, maintenance };
}
