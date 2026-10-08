import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AllModelCommands, AllCodexAgents, AllSkills, AllCodexSkills } from './manifest.js';
import { CodexModelSpecs } from './codex-model-specs.js';
import { OmpAgents } from './omp-scope.js';
import { OmpCommands } from './omp-commands.js';
import { OpencodeAgents } from './opencode-agents.js';
import { OpencodeCommands } from './opencode-commands.js';
import { OpencodeSkills } from './opencode-skills.js';

// Bump when the shape of the `cah models --json` document changes.
export const MODELS_SCHEMA_VERSION = 1;

function packageVersion() {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

export function cmdVersion() {
  process.stdout.write(
    `cc-arch-hands ${packageVersion() ?? '(dev)'} commands=${AllModelCommands.length} agents=${AllModelCommands.length} codex-agents=${AllCodexAgents.length} codex-skills=${AllCodexSkills.length} omp-agents=${OmpAgents.length} omp-commands=${OmpCommands.length} opencode-agents=${OpencodeAgents.length} opencode-skills=${OpencodeSkills.length} opencode-commands=${OpencodeCommands.length} skills=${AllSkills.length}\n`,
  );
  return 0;
}

// The manifest as data, so consumers never have to execute lib/manifest.js.
export function modelsDocument() {
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    version: packageVersion(),
    claude: { aliases: AllModelCommands },
    codex: { aliases: AllCodexAgents, models: CodexModelSpecs },
  };
}

export function cmdModels(rest) {
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    process.stderr.write(`cah models: ${e.message}\n`);
    return 2;
  }
  if (!values.json) {
    process.stderr.write('cah models: --json is required (the only output format)\n');
    return 2;
  }
  process.stdout.write(`${JSON.stringify(modelsDocument())}\n`);
  return 0;
}
