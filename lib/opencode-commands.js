import { OpencodeWorkflows } from './manifest.js';
import { join } from 'node:path';
import { classifyContent, Ownership } from './sentinel.js';
import {
  captureRegularFileSnapshot, writeFileAtomic, removeOwnedRegularFile, pruneOrphans,
  normalizedRelativePath, stablePathExists, emptyMaintenanceReport, mergeMaintenanceReport,
} from './fsutil.js';

export const OpencodeCommands = OpencodeWorkflows;
export const SetForOpencodeCommand = { current: '<!-- cah-opencode-command:v1 -->', legacy: [] };
export const SetForOpencodeRuntime = { current: '// cah-opencode-runtime:v1', legacy: [] };
// Dependency-first publication order: scheduler and helper before the plugin
// that imports them. The plugin lives in the plural `plugins/` directory that
// OpenCode v1.18.34 scans ({plugin,plugins}/*.{js,ts}).
export const OpencodeCommandRuntimeFiles = [
  'cah-opencode/cah-babysit-scheduler.js',
  'cah-opencode/commit-checkpoint.mjs',
  'plugins/cah-babysit.js',
];
// Owned leaves from earlier placements; pruned as migration orphans while
// foreign files in those directories are never touched.
export const LegacyOpencodeRuntimeFiles = [
  'cah-opencode/cah-babysit-plugin.js',
  'plugin/cah-babysit-plugin.js',
  'plugin/cah-babysit.js',
];

function templateLeaf(templates, name, kind, leaf) {
  const files = templates.skillTree(name, kind);
  const file = files.find((entry) => entry.relPath === leaf);
  if (!file || !file.bytes.length) throw new Error(`OpenCode ${name}: missing or empty ${leaf} template`);
  return file.bytes.toString('utf8');
}

export function prepareOpencodeCommands(templates, scope) {
  const root = scope.opencodeRoot();
  const runtimeDir = scope.resolveRuntimeDir();
  const helper = join(runtimeDir, 'commit-checkpoint.mjs').replaceAll('\\', '/');
  const files = [
    { rel: OpencodeCommandRuntimeFiles[0], set: SetForOpencodeRuntime,
      body: templateLeaf(templates, 'scheduler', 'opencode-runtime', 'cah-babysit-scheduler.js') },
    { rel: OpencodeCommandRuntimeFiles[1], set: SetForOpencodeRuntime,
      body: `${templateLeaf(templates, 'ccheckpoint', 'codex-skills', 'scripts/commit-checkpoint.mjs')}\n${SetForOpencodeRuntime.current}\n` },
    { rel: OpencodeCommandRuntimeFiles[2], set: SetForOpencodeRuntime,
      body: templateLeaf(templates, 'plugin', 'opencode-runtime', 'cah-babysit.js') },
  ];
  for (const name of OpencodeCommands) {
    const body = templateLeaf(templates, name, 'opencode-commands', 'command.md');
    if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(body)) {
      throw new Error(`OpenCode ${name}: command template needs YAML frontmatter`);
    }
    files.push({ rel: `commands/${name}.md`, set: SetForOpencodeCommand,
      body: `${body.replaceAll('{{COMMIT_HELPER}}', JSON.stringify(helper))}\n${SetForOpencodeCommand.current}\n` });
  }
  // Preflight snapshots EVERY destination (runtime and command) before any
  // write or uninstall phase can run; the write phase reuses these snapshots.
  for (const file of files) {
    file.snapshot = captureRegularFileSnapshot(join(root, file.rel));
    if (file.set === SetForOpencodeRuntime
        && !file.body.includes(file.set.current)) {
      throw new Error(`OpenCode ${file.rel}: missing runtime sentinel`);
    }
    if (file.snapshot.present
        && classifyContent(true, file.snapshot.content, file.set) === Ownership.foreign
        && file.set === SetForOpencodeRuntime) {
      throw new Error(`OpenCode command runtime is foreign; refusing to overwrite: ${join(root, file.rel)}`);
    }
  }
  return files;
}

export function writeOpencodeCommands(templates, scope, options = {}) {
  const files = prepareOpencodeCommands(templates, scope);
  const root = scope.opencodeRoot();
  let written = 0;
  const skipped = [];
  for (const file of files) {
    const path = join(root, file.rel);
    // Fresh capture at write time: reinstall may have removed owned files
    // between the preflight snapshot and this phase.
    const snapshot = captureRegularFileSnapshot(path);
    if (classifyContent(snapshot.present, snapshot.content, file.set) === Ownership.foreign) {
      if (file.set === SetForOpencodeRuntime) throw new Error(`OpenCode command runtime became foreign: ${path}`);
      skipped.push(file.rel);
      continue;
    }
    writeFileAtomic(path, file.body, {
      expectedDestination: snapshot.expectedDestination, testInterlock: options.testInterlock,
    });
    written++;
  }
  return finish(root, { written, skipped, recovery: [] },
    new Set(OpencodeCommands.map((name) => `${name}.md`)), options);
}

export function removeOpencodeCommands(scope, options = {}) {
  const root = scope.opencodeRoot();
  let removed = 0;
  const skipped = [];
  const recovery = [];
  const files = [
    ...OpencodeCommands.map((name) => ({ rel: `commands/${name}.md`, set: SetForOpencodeCommand })),
    ...LegacyOpencodeRuntimeFiles.map((rel) => ({ rel, set: SetForOpencodeRuntime })),
    ...[...OpencodeCommandRuntimeFiles].reverse().map((rel) => ({ rel, set: SetForOpencodeRuntime })),
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
  const reports = [pruneOrphans(join(root, 'commands'), expected, SetForOpencodeCommand,
    { testInterlock: options.testInterlock })];
  for (const dir of ['cah-opencode', 'plugin', 'plugins']) {
    const known = new Set(expected.size ? OpencodeCommandRuntimeFiles
      .filter((rel) => rel.startsWith(`${dir}/`)).map((rel) => rel.slice(dir.length + 1)) : []);
    reports.push(pruneOrphans(join(root, dir), known, SetForOpencodeRuntime,
      { testInterlock: options.testInterlock }));
  }
  const maintenance = emptyMaintenanceReport();
  let pruned = 0;
  for (const report of reports) {
    pruned += report.pruned;
    for (const path of report.preserved) {
      const rel = normalizedRelativePath(root, path);
      if (!result.skipped.includes(rel)) result.skipped.push(rel);
    }
    for (const path of report.recovery) {
      const rel = normalizedRelativePath(root, path);
      if (!result.recovery.includes(rel)) result.recovery.push(rel);
    }
    mergeMaintenanceReport(maintenance, report.maintenance,
      (path) => normalizedRelativePath(root, path));
  }
  mergeMaintenanceReport(maintenance, { recovery: result.recovery }, (path) => path);
  return { ...result, pruned, maintenance };
}
