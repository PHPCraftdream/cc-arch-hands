import { AllModelCommands } from './manifest.js';
import { SentinelModelAgent, SetForModelAgent } from './sentinel.js';
import { writeLeaves, removeLeaves } from './leaf-installer.js';

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
  const effort = mc.effort == null ? '' : `effort: ${mc.effort}\n`;
  const description = mc.effort == null ? `${mc.model} (${mc.display})` : `${mc.model} effort=${mc.effort} (${mc.display})`;
  const invocation = mc.effort == null
    ? 'You are a delegated worker running on the selected model.\n\n'
    : `You are a delegated worker invoked with reasoning effort: ${mc.effort}.\n\n`;
  return (
    '---\n' +
    `name: ${mc.name}\n` +
    `description: ${description} — delegate task in isolated context\n` +
    `model: ${mc.model}\n` +
    effort +
    '---\n\n' +
    invocation +
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

const leafOf = (mc) => `${mc.name}.md`;

// resolveAgentsDir() applies the strict-scope guard; the first write creates the directory.
// The orphan sweep also takes the a-prefixed files from before v0.2.0.
export function writeModelAgents(_templates, scope, options = {}) {
  return writeLeaves(scope.resolveAgentsDir(),
    AllModelCommands.map((mc) => ({ leaf: leafOf(mc), body: buildAgentBody(mc) })), SetForModelAgent, options);
}

export function removeModelAgents(scope, options = {}) {
  return removeLeaves(scope.resolveAgentsDir(),
    AllModelCommands.flatMap((mc) => [leafOf(mc), `a${leafOf(mc)}`]), SetForModelAgent, options);
}
