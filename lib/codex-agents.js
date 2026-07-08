import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AllCodexAgents } from './manifest.js';
import { SetForCodexAgent, classifyContent, Ownership, SentinelCodexAgent } from './sentinel.js';
import { readFileMaybe, pruneOrphans, writeFileAtomic } from './fsutil.js';

function codexAgentBody(agent) {
  return (
    `${SentinelCodexAgent}\n` +
    `name = "${agent.name}"\n` +
    `description = "${agent.model} effort=${agent.effort} (${agent.display}) - delegated Codex worker"\n` +
    `model = "${agent.model}"\n` +
    `model_reasoning_effort = "${agent.effort}"\n` +
    'developer_instructions = """\n' +
    `You are a delegated Codex worker invoked with reasoning effort: ${agent.effort}.\n\n` +
    'Do the task autonomously. Return only the final result: no preamble, no recap of steps. If the task is a question, answer it directly. If it is an action, do it and report what changed.\n\n' +
    'Git safety - shared workspace. You are one of several agents that may be working in this repository at the same time. Do NOT run any git command that mutates the working tree, index, refs or remotes - specifically git checkout, git switch, git reset, git restore, git stash, git clean, git pull, git rebase, git merge, git branch -D/--delete, git commit, git push, git fetch --prune, git reflog expire. Those operations can clobber another agent\'s in-flight edits or unstaged changes. Read-only inspection is fine (git status, git log, git diff, git show, git branch -v, git rev-parse, git ls-files). Only run a mutating git command when the task prompt you were given explicitly tells you to.\n\n' +
    'Test scope: run only tests that directly cover your changes. Do not run broad project-wide suites unless explicitly requested.\n' +
    '"""\n'
  );
}

export function writeCodexAgents(_templates, scope) {
  const dir = scope.resolveCodexAgentsDir();
  let written = 0;
  const skipped = [];

  for (const agent of AllCodexAgents) {
    const path = join(dir, `${agent.name}.toml`);
    const [present, content] = readFileMaybe(path);
    const ownership = classifyContent(present, content, SetForCodexAgent);

    if (ownership === Ownership.foreign) {
      skipped.push(path);
      continue;
    }

    writeFileAtomic(path, codexAgentBody(agent));
    written++;
  }

  const pruned = pruneOrphans(dir, new Set(AllCodexAgents.map((agent) => `${agent.name}.toml`)), SetForCodexAgent);
  return { written, skipped, pruned };
}

export function removeCodexAgents(scope) {
  const dir = scope.resolveCodexAgentsDir();
  let removed = 0;
  const skipped = [];

  for (const agent of AllCodexAgents) {
    const path = join(dir, `${agent.name}.toml`);
    const [present, content] = readFileMaybe(path);
    const ownership = classifyContent(present, content, SetForCodexAgent);

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
