import { AllModelCommands } from './manifest.js';
import { SentinelModelCommand, SetForModelCommand } from './sentinel.js';
import { writeLeaves, removeLeaves } from './leaf-installer.js';

const SENTINEL_BODY_GAP = 50;

function modelCommandBody(mc) {
  const effort = mc.effort == null ? '' : `effort: ${mc.effort}\n`;
  const description = mc.effort == null ? mc.model : `${mc.model} effort=${mc.effort}`;
  return (
    '---\n' +
    `description: ${description}\n` +
    `model: ${mc.model}\n` +
    effort +
    '---\n\n' +
    '(Switches this turn\'s model/effort — not a request to launch an Agent.)\n\n' +
    '$ARGUMENTS\n' +
    '\n'.repeat(SENTINEL_BODY_GAP) +
    SentinelModelCommand +
    '\n'
  );
}

const leafOf = (mc) => `${mc.name}.md`;

// resolveCommandsDir() applies the strict-scope guard; the first write creates the directory.
export function writeModelCommands(_templates, scope, options = {}) {
  return writeLeaves(scope.resolveCommandsDir(),
    AllModelCommands.map((mc) => ({ leaf: leafOf(mc), body: modelCommandBody(mc) })), SetForModelCommand, options);
}

export function removeModelCommands(scope, options = {}) {
  return removeLeaves(scope.resolveCommandsDir(), AllModelCommands.map(leafOf), SetForModelCommand, options);
}
