// `cah rewake on|off|status` — wire the cah-rewake hooks into settings.json.
// Global scope covers ~/.claude/settings.json and every ccgp profile (ccgp
// copies settings.json into a profile only when it starts, so writing it here
// spares the restart); --local/--cwd cover one project's settings.json.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Scope } from './scope.js';
import { settingsTargets } from './settings-targets.js';
import { readRewakeState, updateRewake } from './rewake.js';

const USAGE = 'Usage:\n  cah rewake on|off|status [--global|--local] [--cwd PATH]\n';
const ACTIONS = { on: 'enable', off: 'disable', status: 'status' };
const LOG_TAIL = 5;

function logTail(binDir) {
  let lines;
  try {
    lines = readFileSync(join(binDir, 'cache', 'rewake.log'), 'utf8').trim().split('\n');
  } catch { return []; }
  return lines.filter(Boolean).slice(-LOG_TAIL);
}

export function cmdRewake(rest) {
  if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
    process.stdout.write(USAGE);
    return rest.length === 0 ? 2 : 0;
  }
  const action = ACTIONS[rest[0]];
  if (!action) {
    process.stderr.write(`cah rewake: unknown action "${rest[0]}" (on|off|status)\n${USAGE}`);
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
    process.stderr.write(`cah rewake: ${error.message}\n`);
    return 2;
  }

  const binDir = new Scope({ global: true }).resolveBinDir();
  const binPath = join(binDir, 'bin', 'cah-rewake.js');
  if (action !== 'disable' && !existsSync(binPath)) {
    process.stderr.write(`cah rewake: ${binPath} is missing; run \`cah install --only bins\` first.\n`);
    return 1;
  }

  let failed = false;
  for (const target of list) {
    try {
      const outcome = action === 'status'
        ? readRewakeState(target.settingsPath, binPath)
        : updateRewake(target.settingsPath, action, { binPath });
      process.stdout.write(`${target.label} (${target.settingsPath}): ${outcome}\n`);
    } catch (error) {
      failed = true;
      process.stderr.write(`${target.label}: ${error.message}\n`);
    }
  }
  if (action === 'status') {
    const tail = logTail(binDir);
    process.stdout.write(tail.length ? `last events:\n${tail.map((line) => `  ${line}`).join('\n')}\n`
      : 'last events: none yet\n');
  } else if (!failed) {
    process.stdout.write('New sessions pick the hooks up; restart a running session if /hooks does not list them.\n');
  }
  return failed ? 1 : 0;
}
