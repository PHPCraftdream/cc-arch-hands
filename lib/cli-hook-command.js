// The shared body of `cah <name> on|off|status` for a feature that is one
// sentinel-tagged hook set of a companion bin in settings.json (`cah rewake`,
// `cah nobg`). Global scope covers ~/.claude/settings.json and every ccgp
// profile (ccgp copies settings.json into a profile only when it starts, so
// writing it here spares the restart); --local/--cwd cover one project's.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Scope } from './scope.js';
import { settingsTargets } from './settings-targets.js';

const ACTIONS = { on: 'enable', off: 'disable', status: 'status' };

// `noun` is 'hook' or 'hooks'; `statusFooter(binDir)` is extra text for `status`.
export function createHookCommand({ name, noun, update, readState, statusFooter = null }) {
  const usage = `Usage:\n  cah ${name} on|off|status [--global|--local] [--cwd PATH]\n`;
  const pronoun = noun === 'hook' ? 'it' : 'them';

  return function run(rest) {
    if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
      process.stdout.write(usage);
      return rest.length === 0 ? 2 : 0;
    }
    const action = ACTIONS[rest[0]];
    if (!action) {
      process.stderr.write(`cah ${name}: unknown action "${rest[0]}" (on|off|status)\n${usage}`);
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
      process.stderr.write(`cah ${name}: ${error.message}\n`);
      return 2;
    }

    const binDir = new Scope({ global: true }).resolveBinDir();
    const binPath = join(binDir, 'bin', `cah-${name}.js`);
    if (action !== 'disable' && !existsSync(binPath)) {
      process.stderr.write(`cah ${name}: ${binPath} is missing; run \`cah install --only bins\` first.\n`);
      return 1;
    }

    let failed = false;
    for (const target of list) {
      try {
        const outcome = action === 'status'
          ? readState(target.settingsPath, binPath)
          : update(target.settingsPath, action, { binPath });
        process.stdout.write(`${target.label} (${target.settingsPath}): ${outcome}\n`);
      } catch (error) {
        failed = true;
        process.stderr.write(`${target.label}: ${error.message}\n`);
      }
    }
    if (action === 'status') {
      if (statusFooter) process.stdout.write(statusFooter(binDir));
    } else if (!failed) {
      process.stdout.write(`New sessions pick the ${noun} up; restart a running session if /hooks does not list ${pronoun}.\n`);
    }
    return failed ? 1 : 0;
  };
}
