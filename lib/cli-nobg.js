// `cah nobg on|off|status` — wire the cah-nobg PreToolUse hook into settings.json.
// Global scope covers ~/.claude/settings.json and every ccgp profile;
// --local/--cwd cover one project's settings.json.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Scope } from './scope.js';
import { settingsTargets } from './settings-targets.js';
import { readNobgState, updateNobg } from './nobg.js';

const USAGE = 'Usage:\n  cah nobg on|off|status [--global|--local] [--cwd PATH]\n';
const ACTIONS = { on: 'enable', off: 'disable', status: 'status' };

export function cmdNobg(rest) {
  if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
    process.stdout.write(USAGE);
    return rest.length === 0 ? 2 : 0;
  }
  const action = ACTIONS[rest[0]];
  if (!action) {
    process.stderr.write(`cah nobg: unknown action "${rest[0]}" (on|off|status)\n${USAGE}`);
    return 2;
  }
  let list;
  try {
    const { values } = parseArgs({
      args: rest.slice(1), strict: true, allowPositionals: false,
      options: {
        global: { type: 'boolean', default: false },
        local: { type: 'boolean', default: false },
        cwd: { type: 'string', default: '' },
      },
    });
    list = settingsTargets(values);
  } catch (error) {
    process.stderr.write(`cah nobg: ${error.message}\n`);
    return 2;
  }

  const binPath = join(new Scope({ global: true }).resolveBinDir(), 'bin', 'cah-nobg.js');
  if (action !== 'disable' && !existsSync(binPath)) {
    process.stderr.write(`cah nobg: ${binPath} is missing; run \`cah install --only bins\` first.\n`);
    return 1;
  }

  let failed = false;
  for (const target of list) {
    try {
      const outcome = action === 'status'
        ? readNobgState(target.settingsPath, binPath)
        : updateNobg(target.settingsPath, action, { binPath });
      process.stdout.write(`${target.label} (${target.settingsPath}): ${outcome}\n`);
    } catch (error) {
      failed = true;
      process.stderr.write(`${target.label}: ${error.message}\n`);
    }
  }
  if (action !== 'status' && !failed) {
    process.stdout.write('New sessions pick the hook up; restart a running session if /hooks does not list it.\n');
  }
  return failed ? 1 : 0;
}
