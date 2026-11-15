import { join } from 'node:path';
import { createMarkedSection } from './marked-section.js';

export const OMP_AGENT_TAGS_BEGIN = '<!-- cah-omp-agent-tags:start -->';
export const OMP_AGENT_TAGS_END = '<!-- cah-omp-agent-tags:end -->';

const SECTION = `${OMP_AGENT_TAGS_BEGIN}
## Agent tags

The short names ls, ms, hs, xs, xxs and the other registered agent names
denote specific executors, not models for the main session.

When the user explicitly asks to hand work to an agent or agents and names
them, call those agents by their exact names.
For example: "hs review the code", "give xxa the research".

Mentioning a name while discussing configuration is not a request to run it.
Never launch subagents without the user's explicit request.
Never replace the chosen agent with another and never change the main session's model.

Ultra must stay the literal ultra in the definition and in the request.
Never replace it with max, xhigh, another mode or another executor.
Never hide missing support or usage errors: report them to the user.
${OMP_AGENT_TAGS_END}`;

const marked = createMarkedSection({
  begin: OMP_AGENT_TAGS_BEGIN, end: OMP_AGENT_TAGS_END, section: SECTION, label: 'OMP APPEND_SYSTEM.md agent-tag',
});

export function ompInstructionsPath(scope) {
  return join(scope.agentRoot(), 'APPEND_SYSTEM.md');
}

export function inspectOmpInstructions(scope) {
  return marked.inspect(ompInstructionsPath(scope));
}

export function writeOmpInstructions(scope) {
  return marked.write(ompInstructionsPath(scope));
}

export function removeOmpInstructions(scope) {
  return marked.remove(ompInstructionsPath(scope));
}

export function classifyOmpInstructions(scope) {
  try {
    return inspectOmpInstructions(scope).range ? 'mine' : 'missing';
  } catch {
    return 'foreign';
  }
}
