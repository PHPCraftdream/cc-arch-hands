import { join } from 'node:path';
import { captureRegularFileSnapshot } from './fsutil.js';
import { createMarkedSection } from './marked-section.js';

export const CODEX_CLI_RUN_BEGIN = '<!-- cah-cli-run:start -->';
export const CODEX_CLI_RUN_END = '<!-- cah-cli-run:end -->';

const SECTION = `${CODEX_CLI_RUN_BEGIN}
## Long-running CLI commands through the cli-run MCP tools

- Run commands expected to finish in seconds directly with native file/terminal tools: \`git status\`, \`git diff\`, \`git log\`, \`rg\`, file listings, and source reads. Do not route them through \`cli-run\`.
- Use the \`cli-run\` MCP tool \`run\` (see the \`$cli-run\` skill) for potentially long-running commands such as test suites, builds, compilation, substantial copies, and \`gh run watch\`. Pass only those commands as jobs. Approval and scope rules still apply before launch.
- Give each \`run\` a short \`taskName\`. The tool acknowledgment already shows the assigned name and UID; do not repeat them in chat or invent a UID.
- Jobs run detached, without interactive stdin or a PTY; their combined stdout/stderr go to per-job logs. If a command needs interactive stdin, stop and ask.
- For long-running jobs in native spawned agents, call \`run\` with \`delivery: "inline"\`. It returns completed jobs in the tool response without \`codex queue\`. Set \`showOutput: true\` only when output is needed; output may contain secrets.
- For longer jobs in the main thread, default queued delivery posts one brief completion for the whole task: name, UID, and success/failure count. It omits command output. Do not echo a successful completion or call \`status\`/\`logs\` just to confirm it. Use those tools only on failure, when asked, or when further work needs details; repeated names select the newest run.
- Keep the job array minimal and task-directed; do not run generic version or workspace-inventory probes unless needed. Never relaunch jobs from an acknowledged run.
- With queued delivery, a \`run\` result is not command completion. Follow the existing completion and waiting rules in this AGENTS.md; do not infer success from launch or poll \`status\`. When a \`cli-run <id>\` completion message arrives, inspect its result. With inline delivery, the tool response is the completion; no queued message follows.
- If the \`cli-run\` MCP tools are unavailable for a long-running job, stop and ask rather than silently running it another way. This does not restrict direct quick commands.
${CODEX_CLI_RUN_END}`;

const marked = createMarkedSection({
  begin: CODEX_CLI_RUN_BEGIN, end: CODEX_CLI_RUN_END, section: SECTION, label: 'Codex AGENTS.md cli-run',
});

export function codexInstructionsPath(scope) {
  return join(scope.codexRoot(), 'AGENTS.md');
}

export function assertCodexInstructionsActive(scope) {
  const override = captureRegularFileSnapshot(join(scope.codexRoot(), 'AGENTS.override.md'));
  if (override.present && override.content.toString('utf8').trim()) {
    throw new Error('AGENTS.override.md masks the global Codex AGENTS.md');
  }
}

export function inspectCodexInstructions(scope) {
  return marked.inspect(codexInstructionsPath(scope));
}

export function writeCodexInstructions(scope) {
  assertCodexInstructionsActive(scope);
  return marked.write(codexInstructionsPath(scope));
}

export function removeCodexInstructions(scope) {
  return marked.remove(codexInstructionsPath(scope));
}

export function classifyCodexInstructions(scope) {
  try {
    assertCodexInstructionsActive(scope);
    return inspectCodexInstructions(scope).range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
