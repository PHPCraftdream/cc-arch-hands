// `cah checkpoint-watch on [--commit] | off | status [--cwd PATH]` — turn the
// checkpoint-watch mod on for one project (never globally: not every folder is
// a repository where an automatic checkpoint, commit and compaction are fine).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Scope } from './scope.js';
import { readWatchState, updateWatch } from './checkpoint-watch.js';

const USAGE = 'Usage:\n  cah checkpoint-watch on [--commit] | off | status [--cwd PATH]\n';
const ACTIONS = { on: 'enable', off: 'disable', status: 'status' };

function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
}

export function modInstalled(claudeRoot) {
  return existsSync(join(claudeRoot, 'skills', 'checkpoint-watch', '.claude-plugin', 'plugin.json'));
}

export function cmdCheckpointWatch(rest) {
  if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
    process.stdout.write(USAGE);
    return rest.length === 0 ? 2 : 0;
  }
  const action = ACTIONS[rest[0]];
  if (!action) {
    process.stderr.write(`cah checkpoint-watch: unknown action "${rest[0]}" (on|off|status)\n${USAGE}`);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest.slice(1), strict: true, allowPositionals: false,
      options: {
        commit: { type: 'boolean', default: false },
        cwd: { type: 'string', default: '' },
      },
    }));
    if (values.commit && action !== 'enable') throw new Error('--commit applies to "on" only');
  } catch (error) {
    process.stderr.write(`cah checkpoint-watch: ${error.message}\n`);
    return 2;
  }

  const dir = resolve(values.cwd || process.cwd());
  const paths = {
    localPath: join(dir, '.claude', 'settings.local.json'),
    projectPath: join(dir, '.claude', 'settings.json'),
  };
  const claudeRoot = new Scope({ global: true }).claudeRoot();

  try {
    if (action === 'status') {
      const state = readWatchState(paths);
      process.stdout.write(`project (${paths.localPath}): ${state.mode ? `enabled, mode ${state.mode}` : 'not enabled'}\n`);
      if (state.legacyHook) process.stdout.write(`legacy Stop hint hook in ${paths.projectPath}: present (on/off removes it)\n`);
      process.stdout.write(`mod: ${modInstalled(claudeRoot) ? 'installed' : 'missing'} (${join(claudeRoot, 'skills', 'checkpoint-watch')})\n`);
      return 0;
    }
    if (action === 'enable' && git(dir, 'rev-parse', '--show-toplevel').status !== 0) {
      process.stderr.write(`cah checkpoint-watch: ${dir} is not inside a Git repository; nothing was written\n`);
      return 1;
    }
    const mode = values.commit ? 'commit' : 'checkpoint';
    const outcome = updateWatch(paths, action, { mode });
    const label = action === 'enable' ? `${outcome.local} (mode ${mode})` : outcome.local;
    process.stdout.write(`project (${paths.localPath}): ${label}\n`);
    if (outcome.legacy) process.stdout.write(`legacy Stop hint hook in ${paths.projectPath}: ${outcome.legacy}\n`);
    if (action === 'enable') {
      if (git(dir, 'check-ignore', '-q', '--', '.claude/settings.local.json').status === 1) {
        process.stdout.write('note: .claude/settings.local.json is not ignored by Git; add it to .gitignore\n');
      }
      if (!modInstalled(claudeRoot)) {
        process.stdout.write('note: the mod is missing; run `cah install --only checkpoint-watch`, then /reload-plugins\n');
      }
    }
    return 0;
  } catch (error) {
    process.stderr.write(`cah checkpoint-watch: ${error.message}\n`);
    return 1;
  }
}
