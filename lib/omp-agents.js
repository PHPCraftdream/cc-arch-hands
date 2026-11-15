import { OmpAgents, SetForOmpAgent, SentinelOmpAgent } from './omp-scope.js';
import { writeLeaves, removeLeaves } from './leaf-installer.js';

function ompAgentBody(agent) {
  return `---
name: ${agent.name}
description: ${agent.display}. Invoke when the user requests ${agent.name}.
model: openai-codex/${agent.model}
thinking-level: ${agent.effort}
---

Complete the assigned task in full. Respect the user's constraints.

${SentinelOmpAgent}
`;
}

const leafOf = (agent) => `${agent.name}.md`;

export function writeOmpAgents(_templates, scope, options = {}) {
  return writeLeaves(scope.resolveAgentsDir(),
    OmpAgents.map((agent) => ({ leaf: leafOf(agent), body: ompAgentBody(agent) })), SetForOmpAgent, options);
}

export function removeOmpAgents(scope, options = {}) {
  return removeLeaves(scope.resolveAgentsDir(), OmpAgents.map(leafOf), SetForOmpAgent, options);
}
