import { AllCodexAgents } from './manifest.js';
import { writeLeaves, removeLeaves } from './leaf-installer.js';

export const OpencodeAgents = AllCodexAgents;
export const SentinelOpencodeAgent = '<!-- cah-opencode-agent:v1 -->';
export const SetForOpencodeAgent = { current: SentinelOpencodeAgent, legacy: [] };

function opencodeAgentBody(agent) {
  return `---
name: ${agent.name}
description: ${agent.display}. Invoke when the user requests ${agent.name}.
mode: subagent
model: openai/${agent.model}
options:
  reasoningEffort: ${agent.effort}
---

Complete the assigned task in full. Respect the user's constraints.

${SentinelOpencodeAgent}
`;
}

const leafOf = (agent) => `${agent.name}.md`;

export function writeOpencodeAgents(_templates, scope, options = {}) {
  return writeLeaves(scope.resolveAgentsDir(),
    OpencodeAgents.map((agent) => ({ leaf: leafOf(agent), body: opencodeAgentBody(agent) })), SetForOpencodeAgent, options);
}

export function removeOpencodeAgents(scope, options = {}) {
  return removeLeaves(scope.resolveAgentsDir(), OpencodeAgents.map(leafOf), SetForOpencodeAgent, options);
}
