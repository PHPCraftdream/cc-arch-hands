import { join } from 'node:path';
import { captureRegularFileSnapshot, writeFileAtomic } from './fsutil.js';

export const CODEX_CLI_RUN_BEGIN = '<!-- cah-cli-run:start -->';
export const CODEX_CLI_RUN_END = '<!-- cah-cli-run:end -->';

const SECTION = `${CODEX_CLI_RUN_BEGIN}
## CLI commands through $cli-run

- Start every CLI command for a user task through the \`$cli-run\` skill. Give it the command or command array; do not launch those commands directly with a terminal/exec tool. Approval and scope rules still apply before launch.
- The direct launcher command needed to start \`cli-run\`, and \`cli-run status --run <id>\` used to read its result, are bootstrap exceptions. If \`cli-run\` is unavailable or a command needs interactive stdin, stop and ask rather than silently bypassing it.
- A launcher acknowledgment is not command completion. Follow the existing completion and waiting rules in this AGENTS.md; do not infer success from launch. When a \`cli-run <id>\` completion message arrives, inspect its result and continue required work.
${CODEX_CLI_RUN_END}`;

const beginBytes = Buffer.from(CODEX_CLI_RUN_BEGIN);
const endBytes = Buffer.from(CODEX_CLI_RUN_END);
const sectionBytes = Buffer.from(SECTION);

function positions(content, marker) {
  const found = [];
  for (let from = 0; ; ) {
    const at = content.indexOf(marker, from);
    if (at < 0) return found;
    found.push(at);
    from = at + marker.length;
  }
}

function sectionRange(content) {
  const starts = positions(content, beginBytes);
  const ends = positions(content, endBytes);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0] + beginBytes.length) {
    throw new Error('Codex AGENTS.md has incomplete or duplicate cli-run markers');
  }
  const start = starts[0];
  const end = ends[0] + endBytes.length;
  if ((start > 0 && content[start - 1] !== 10)
      || (end < content.length && content[end] !== 10 && content[end] !== 13)) {
    throw new Error('Codex AGENTS.md cli-run markers must occupy their own lines');
  }
  return { start, end };
}

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
  const path = codexInstructionsPath(scope);
  const snapshot = captureRegularFileSnapshot(path);
  return { path, snapshot, range: sectionRange(snapshot.content ?? Buffer.alloc(0)) };
}

export function writeCodexInstructions(scope) {
  assertCodexInstructionsActive(scope);
  const { path, snapshot, range } = inspectCodexInstructions(scope);
  const original = snapshot.content ?? Buffer.alloc(0);
  const updated = range
    ? Buffer.concat([original.subarray(0, range.start), sectionBytes, original.subarray(range.end)])
    : Buffer.concat([original, original.length ? Buffer.from('\n\n') : Buffer.alloc(0),
      sectionBytes, Buffer.from('\n')]);
  if (updated.equals(original)) return { written: 0, skipped: [] };
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { written: 1, skipped: [] };
}

export function removeCodexInstructions(scope) {
  const { path, snapshot, range } = inspectCodexInstructions(scope);
  if (!range) return { removed: 0, skipped: [] };
  const original = snapshot.content;
  const prefixStart = range.start >= 2 && original[range.start - 2] === 10
    && original[range.start - 1] === 10 ? range.start - 2 : range.start;
  let suffixStart = range.end;
  if (suffixStart + 1 === original.length && original[suffixStart] === 10) suffixStart++;
  const updated = Buffer.concat([original.subarray(0, prefixStart), original.subarray(suffixStart)]);
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { removed: 1, skipped: [] };
}

export function classifyCodexInstructions(scope) {
  try {
    assertCodexInstructionsActive(scope);
    const { range } = inspectCodexInstructions(scope);
    return range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
