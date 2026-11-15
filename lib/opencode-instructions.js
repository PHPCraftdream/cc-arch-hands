import { captureRegularFileSnapshot, writeFileAtomic, removeOwnedRegularFile } from './fsutil.js';
import { positions } from './marked-section.js';

export const OPENCODE_AGENT_TAGS_BEGIN = '<!-- cah-opencode-agent-tags:start -->';
export const OPENCODE_AGENT_TAGS_END = '<!-- cah-opencode-agent-tags:end -->';

const SECTION = `${OPENCODE_AGENT_TAGS_BEGIN}
## OpenCode agent tags

The short names ls, ms, hs, xs, xxs and the other registered agent names
denote specific executors (subagents), not models for the main session.

When the user explicitly asks to hand work to an agent or agents and names
them, delegate the task to that subagent by its exact name through the task
delegation mechanism (the task tool).
For example: "hs review the code", "give xxa the research".
An agent name in a request means "delegate to this subagent", not a change
of the main session's model.

Mentioning a name while discussing configuration is not a request to run it.
Never launch subagents without the user's explicit request.
Never replace the chosen agent with another and never change the main session's model.

Ultra must stay the literal ultra in the definition and in the request.
Never replace it with max, xhigh, another mode or another executor.
Never hide missing support or usage errors: report them to the user.
${OPENCODE_AGENT_TAGS_END}`;

const beginBytes = Buffer.from(OPENCODE_AGENT_TAGS_BEGIN);
const endBytes = Buffer.from(OPENCODE_AGENT_TAGS_END);

function sectionRange(content) {
  const starts = positions(content, beginBytes);
  const ends = positions(content, endBytes);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0] + beginBytes.length) {
    throw new Error('OpenCode AGENTS.md has incomplete or duplicate agent-tag markers');
  }
  const start = starts[0];
  const end = ends[0] + endBytes.length;
  if ((start > 0 && content[start - 1] !== 10)
      || (start + beginBytes.length < content.length && content[start + beginBytes.length] !== 10
        && !(content[start + beginBytes.length] === 13 && content[start + beginBytes.length + 1] === 10))
      || (ends[0] > 0 && content[ends[0] - 1] !== 10)
      || (end < content.length && content[end] !== 10
        && !(content[end] === 13 && content[end + 1] === 10))) {
    throw new Error('OpenCode AGENTS.md agent-tag markers must occupy their own lines');
  }
  return { start, end };
}

export function opencodeInstructionsPath(scope) {
  return scope.instructionsPath();
}

export function inspectOpencodeInstructions(scope) {
  const path = opencodeInstructionsPath(scope);
  const snapshot = captureRegularFileSnapshot(path);
  return { path, snapshot, range: sectionRange(snapshot.content ?? Buffer.alloc(0)) };
}

export function writeOpencodeInstructions(scope) {
  const { path, snapshot, range } = inspectOpencodeInstructions(scope);
  const original = snapshot.content ?? Buffer.alloc(0);
  const padding = range ? original.subarray(range.start, range.end).toString('utf8')
    .match(/<!-- cah-opencode-agent-tags:padding:(0|2):1 -->/)?.[0] : null;
  const rendered = Buffer.from(SECTION.replace(OPENCODE_AGENT_TAGS_BEGIN,
    `${OPENCODE_AGENT_TAGS_BEGIN}${padding ? `\n${padding}` : !range ? `\n<!-- cah-opencode-agent-tags:padding:${original.length ? 2 : 0}:1 -->` : ''}`));
  const updated = range
    ? Buffer.concat([original.subarray(0, range.start), rendered, original.subarray(range.end)])
    : Buffer.concat([original, original.length ? Buffer.from('\n\n') : Buffer.alloc(0),
      rendered, Buffer.from('\n')]);
  if (updated.equals(original)) return { written: 0, skipped: [] };
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { written: 1, skipped: [] };
}

export function removeOpencodeInstructions(scope) {
  const { path, snapshot, range } = inspectOpencodeInstructions(scope);
  if (!range) return { removed: 0, skipped: [] };
  const original = snapshot.content;
  const padding = original.subarray(range.start, range.end).toString('utf8')
    .match(/<!-- cah-opencode-agent-tags:padding:(0|2):1 -->/);
  const prefixStart = padding?.[1] === '2' && range.start >= 2
    && original[range.start - 2] === 10 && original[range.start - 1] === 10
    ? range.start - 2 : range.start;
  let suffixStart = range.end;
  if (padding && original[suffixStart] === 10) suffixStart++;
  const updated = Buffer.concat([original.subarray(0, prefixStart), original.subarray(suffixStart)]);
  // A file that only ever held our section (installed into an empty file) goes
  // away with it instead of being left behind empty.
  if (updated.length === 0 && padding?.[1] === '0') {
    removeOwnedRegularFile(path, snapshot.expectedDestination);
    return { removed: 1, skipped: [] };
  }
  writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
  return { removed: 1, skipped: [] };
}

export function classifyOpencodeInstructions(scope) {
  try {
    const { range } = inspectOpencodeInstructions(scope);
    return range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
