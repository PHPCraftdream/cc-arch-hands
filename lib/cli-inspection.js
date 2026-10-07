import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Scope, SKILL_MANIFEST_LEAF } from './scope.js';
import { AllModelCommands, AllCodexAgents, AllSkills, AllCodexSkills } from './manifest.js';
import { SetForModelCommand, SetForModelAgent, SetForCodexAgent, SetForSkill, SetForBin, Ownership, classifyContent } from './sentinel.js';
import { OmpScope, OmpAgents, SetForOmpAgent } from './omp-scope.js';
import { classifyOmpInstructions } from './omp-instructions.js';
import { OmpCommands, OmpCommandRuntimeFiles, SetForOmpCommand, SetForOmpCommandRuntime } from './omp-commands.js';
import { OpencodeAgents, SetForOpencodeAgent } from './opencode-agents.js';
import { classifyOpencodeInstructions } from './opencode-instructions.js';
import { OpencodeCommands, OpencodeCommandRuntimeFiles, SetForOpencodeCommand, SetForOpencodeRuntime } from './opencode-commands.js';
import { OpencodeSkills } from './opencode-skills.js';
import { classifyCodexInstructions } from './codex-instructions.js';
import { classifyCodexMcpConfig } from './codex-mcp-config.js';
import { BinFiles, structuralLeafRejection } from './binstall.js';

export function classifyPath(path, set, options = {}) {
  try {
    if (options.structural ? structuralLeafRejection(path) !== null : !lstatSync(path).isFile()) {
      return Ownership.foreign;
    }
    return classifyContent(true, readFileSync(path), set).toString();
  } catch (e) {
    return e.code === 'ENOENT' ? Ownership.missing : Ownership.foreign;
  }
}

function enumerateOpencode(scope) {
  const root = scope.opencodeRoot();
  return [
    ...OpencodeAgents.map((agent) => ({ name: agent.name, kind: 'opencode-agent',
      state: classifyPath(join(scope.resolveAgentsDir(), `${agent.name}.md`), SetForOpencodeAgent) })),
    { name: 'AGENTS.md', kind: 'opencode-instructions', state: classifyOpencodeInstructions(scope) },
    ...OpencodeCommands.map((name) => ({ name, kind: 'opencode-command',
      state: classifyPath(join(scope.resolveCommandsDir(), `${name}.md`), SetForOpencodeCommand) })),
    ...OpencodeCommandRuntimeFiles.map((name) => ({ name, kind: 'opencode-command-runtime',
      state: classifyPath(join(root, name), SetForOpencodeRuntime, { structural: true }) })),
    ...OpencodeSkills.map((name) => ({ name, kind: 'opencode-skill',
      state: classifyPath(join(scope.resolveSkillsDir(), name, SKILL_MANIFEST_LEAF), SetForSkill) })),
  ];
}

export function enumerate(scope, ompProfile = '', ocScope = null, ocOnly = false) {
  if (ocOnly) return enumerateOpencode(ocScope);
  const commandsDir = scope.resolveCommandsDir();
  const agentsDir = scope.resolveAgentsDir();
  const codexAgentsDir = scope.resolveCodexAgentsDir();
  const codexSkillsDir = scope.resolveCodexSkillsDir();
  const skillsDir = scope.resolveSkillsDir();
  const rows = [];
  for (const mc of AllModelCommands) {
    rows.push({ name: mc.name, kind: 'command',
      state: classifyPath(join(commandsDir, `${mc.name}.md`), SetForModelCommand) });
  }
  for (const mc of AllModelCommands) {
    rows.push({ name: mc.name, kind: 'agent',
      state: classifyPath(join(agentsDir, `${mc.name}.md`), SetForModelAgent) });
  }
  for (const agent of AllCodexAgents) {
    rows.push({ name: agent.name, kind: 'codex-agent',
      state: classifyPath(join(codexAgentsDir, `${agent.name}.toml`), SetForCodexAgent) });
  }
  for (const name of AllSkills) {
    rows.push({ name, kind: 'skill', state: classifyPath(join(skillsDir, name, SKILL_MANIFEST_LEAF), SetForSkill) });
  }
  for (const name of AllCodexSkills) {
    rows.push({ name, kind: 'codex-skill', state: classifyPath(join(codexSkillsDir, name, SKILL_MANIFEST_LEAF), SetForSkill) });
  }
  rows.push({ name: 'AGENTS.md', kind: 'codex-instructions',
    state: classifyCodexInstructions(new Scope({ global: true })) });
  rows.push({ name: 'config.toml', kind: 'codex-mcp-config', state: classifyCodexMcpConfig(scope) });
  const ompScope = new OmpScope(ompProfile);
  for (const agent of OmpAgents) {
    rows.push({ name: agent.name, kind: 'omp-agent',
      state: classifyPath(join(ompScope.resolveAgentsDir(), `${agent.name}.md`), SetForOmpAgent) });
  }
  rows.push({ name: 'APPEND_SYSTEM.md', kind: 'omp-instructions', state: classifyOmpInstructions(ompScope) });
  for (const name of OmpCommands) {
    rows.push({ name, kind: 'omp-command',
      state: classifyPath(join(ompScope.agentRoot(), 'commands', `${name}.md`), SetForOmpCommand) });
  }
  for (const name of OmpCommandRuntimeFiles) {
    rows.push({ name, kind: 'omp-command-runtime',
      state: classifyPath(join(ompScope.agentRoot(), name), SetForOmpCommandRuntime) });
  }
  const binDir = scope.resolveBinDir();
  for (const f of BinFiles) {
    rows.push({ name: f.dest, kind: 'bin',
      state: classifyPath(join(binDir, f.dest), SetForBin, { structural: true }) });
  }
  if (ocScope) rows.push(...enumerateOpencode(ocScope));
  return rows;
}

export function opencodeSelection(vals) {
  const groups = [];
  if (vals['opencode-agents']) groups.push('opencode-agent', 'opencode-instructions');
  if (vals['opencode-commands']) groups.push('opencode-command', 'opencode-command-runtime');
  if (vals['opencode-skills']) groups.push('opencode-skill');
  if (vals.opencode) return { all: true };
  return groups.length > 0 ? { all: false, kinds: groups } : null;
}

export function filterOcSelection(rows, selection) {
  if (selection.all) return rows;
  const kinds = new Set(selection.kinds);
  return rows.filter((r) => kinds.has(r.kind));
}
