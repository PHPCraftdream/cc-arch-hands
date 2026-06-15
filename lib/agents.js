import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AllModelCommands } from './manifest.js';
import { SentinelModelAgent, SetForModelAgent, classifyContent, Ownership } from './sentinel.js';

const agentGitSafetyClause =
  '**Git safety — shared workspace.** You are one of several agents that ' +
  'may be working in this repository at the same time. Do NOT run any ' +
  'git command that mutates the working tree, index, refs or remotes — ' +
  'specifically `git checkout`, `git switch`, `git reset`, `git restore`, ' +
  '`git stash`, `git clean`, `git pull`, `git rebase`, `git merge`, ' +
  '`git branch -D/--delete`, `git commit`, `git push`, `git fetch --prune`, ' +
  '`git reflog expire`. Those operations can clobber another agent\'s ' +
  'in-flight edits or unstaged changes. Read-only inspection is fine ' +
  '(`git status`, `git log`, `git diff`, `git show`, `git branch -v`, ' +
  '`git rev-parse`, `git ls-files`). Only run a mutating git command ' +
  'when the task prompt you were given **explicitly tells you to**.\n';

const agentTestScopeClause =
  '**Test scope — no global test suites.** Run ONLY tests that directly ' +
  'cover YOUR changes — the package(s) or module(s) you modified or created. ' +
  'Do NOT run project-wide test suites (e.g. `make test`, `npm test` at the ' +
  'root, `go test ./...`, `pytest`, `cargo test` without path scoping, or ' +
  'equivalent broad commands). The orchestrator will run the full suite ' +
  'after all agents complete their work and will delegate any regressions ' +
  'back to the responsible agent.\n';

function buildAgentBody(mc) {
  return (
    '---\n' +
    `name: a${mc.name}\n` +
    `description: ${mc.model} effort=${mc.effort} (${mc.display}) — delegate task in isolated context\n` +
    `model: ${mc.model}\n` +
    '---\n\n' +
    `You are a delegated worker invoked with reasoning effort: ${mc.effort}.\n\n` +
    'The user passed:\n\n' +
    '$ARGUMENTS\n\n' +
    'Do the task autonomously. Return only the final result — no preamble, no recap of steps. If the task is a question, answer it directly. If it\'s an action, do it and report what changed.\n\n' +
    agentGitSafetyClause +
    '\n' +
    agentTestScopeClause +
    '\n' +
    SentinelModelAgent +
    '\n'
  );
}

export function writeModelAgents(_templates, scope) {
  const dir = scope.resolveAgentsDir();
  mkdirSync(dir, { recursive: true });

  let written = 0;
  const skipped = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `a${mc.name}.md`);
    const [content, present] = readAgentFile(path);
    if (present) {
      const ownership = classifyContent(true, content, SetForModelAgent);
      if (ownership === Ownership.foreign) {
        skipped.push(path);
        continue;
      }
    }

    writeFileSync(path, buildAgentBody(mc));
    written++;
  }
  return { written, skipped };
}

export function removeModelAgents(scope) {
  const dir = scope.resolveAgentsDir();
  let removed = 0;
  const skipped = [];

  for (const mc of AllModelCommands) {
    const path = join(dir, `a${mc.name}.md`);
    const [content, present] = readAgentFile(path);
    if (!present) continue;

    const ownership = classifyContent(true, content, SetForModelAgent);
    if (ownership === Ownership.foreign) {
      skipped.push(path);
      continue;
    }

    unlinkSync(path);
    removed++;
  }
  return { removed, skipped };
}

function readAgentFile(path) {
  try {
    return [readFileSync(path), true];
  } catch (e) {
    if (e.code === 'ENOENT') return [null, false];
    throw e;
  }
}
