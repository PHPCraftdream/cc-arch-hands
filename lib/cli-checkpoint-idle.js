// `cah checkpoint-idle on [--commit] [--minutes N] | off | status`
//   [--global | --local] [--cwd PATH]
// Switches the checkpoint-watch mod's silence cycle: after N minutes without a
// turn (and 200k+ tokens of context) it saves a checkpoint, compacts the
// session and resumes. Default scope is the project (its settings.local.json);
// --global writes ~/.claude/settings.json and every ccgp profile's. The project
// setting wins over the global one, and `off` in a project mutes a global one.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Scope } from './scope.js';
import { settingsTargets } from './settings-targets.js';
import { modInstalled } from './cli-checkpoint-watch.js';
import {
  IDLE_DEFAULT_MINUTES, IDLE_MAX_MINUTES, IDLE_MIN_MINUTES, describeIdle, readIdleState, updateIdle,
} from './checkpoint-idle.js';

const USAGE = 'Usage:\n  cah checkpoint-idle on [--commit] [--minutes N] | off | status [--global|--local] [--cwd PATH]\n';
const ACTIONS = { on: 'enable', off: 'disable', status: 'status' };

function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
}

function parseMinutes(text) {
  if (text === '') return undefined;
  const minutes = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(minutes >= IDLE_MIN_MINUTES && minutes <= IDLE_MAX_MINUTES)) {
    throw new Error(`--minutes must be a whole number from ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES}`);
  }
  return minutes;
}

function status(localPath, userTargets, claudeRoot) {
  const lines = [];
  const states = userTargets.map((t) => ({ ...t, state: readIdleState(t.settingsPath) }));
  for (const t of states) lines.push(`${t.label} (${t.settingsPath}): ${describeIdle(t.state)}`);
  const local = readIdleState(localPath);
  lines.push(`project (${localPath}): ${describeIdle(local)}`);
  const effective = local !== undefined ? ['project', local] : ['global', states[0].state];
  lines.push(`effective here: ${effective[1] === undefined ? 'off (not set)' : describeIdle(effective[1])}`
    + `${effective[1] === undefined ? '' : ` (from ${effective[0]})`}`);
  lines.push(`mod: ${modInstalled(claudeRoot) ? 'installed' : 'missing'} (${join(claudeRoot, 'skills', 'checkpoint-watch')})`);
  return lines.join('\n') + '\n';
}

export function cmdCheckpointIdle(rest) {
  if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
    process.stdout.write(USAGE);
    return rest.length === 0 ? 2 : 0;
  }
  const action = ACTIONS[rest[0]];
  if (!action) {
    process.stderr.write(`cah checkpoint-idle: unknown action "${rest[0]}" (on|off|status)\n${USAGE}`);
    return 2;
  }
  let values;
  let minutes;
  try {
    ({ values } = parseArgs({
      args: rest.slice(1), strict: true, allowPositionals: false,
      options: {
        commit: { type: 'boolean', default: false },
        minutes: { type: 'string', default: '' },
        global: { type: 'boolean', default: false },
        local: { type: 'boolean', default: false },
        cwd: { type: 'string', default: '' },
      },
    }));
    if (values.global && (values.local || values.cwd)) throw new Error('--global cannot be combined with --local or --cwd');
    if ((values.commit || values.minutes) && action !== 'enable') throw new Error('--commit and --minutes apply to "on" only');
    minutes = parseMinutes(values.minutes);
  } catch (error) {
    process.stderr.write(`cah checkpoint-idle: ${error.message}\n`);
    return 2;
  }

  const dir = resolve(values.cwd || process.cwd());
  const localPath = join(dir, '.claude', 'settings.local.json');
  const claudeRoot = new Scope({ global: true }).claudeRoot();

  try {
    const userTargets = settingsTargets({ global: true, local: false, cwd: '' });
    if (action === 'status') {
      process.stdout.write(status(localPath, userTargets, claudeRoot));
      return 0;
    }
    if (action === 'enable' && !values.global && git(dir, 'rev-parse', '--show-toplevel').status !== 0) {
      process.stderr.write(`cah checkpoint-idle: ${dir} is not inside a Git repository; nothing was written\n`);
      return 1;
    }
    const targets = values.global ? userTargets : [{ label: 'project', settingsPath: localPath }];
    const mode = values.commit ? 'commit' : 'checkpoint';
    // A project `off` must override a global setting; with none, dropping the key is enough.
    const muteLocal = !values.global && userTargets.some((t) => {
      const state = readIdleState(t.settingsPath);
      return state !== undefined && state !== null;
    });
    let failed = false;
    for (const target of targets) {
      try {
        let outcome;
        if (action === 'enable') {
          const kept = readIdleState(target.settingsPath);
          const wanted = minutes ?? (kept ? kept.minutes : IDLE_DEFAULT_MINUTES);
          outcome = `${updateIdle(target.settingsPath, 'enable', { mode, minutes: wanted })} (mode ${mode}, ${wanted} min)`;
        } else {
          outcome = updateIdle(target.settingsPath, muteLocal ? 'mute' : 'disable');
        }
        process.stdout.write(`${target.label} (${target.settingsPath}): ${outcome}\n`);
      } catch (error) {
        failed = true;
        process.stderr.write(`${target.label}: ${error.message}\n`);
      }
    }
    if (action === 'enable' && !failed) {
      if (!values.global && git(dir, 'check-ignore', '-q', '--', '.claude/settings.local.json').status === 1) {
        process.stdout.write('note: .claude/settings.local.json is not ignored by Git; add it to .gitignore\n');
      }
      if (!modInstalled(claudeRoot)) {
        process.stdout.write('note: the mod is missing; run `cah install --only checkpoint-watch`, then /reload-plugins\n');
      }
      process.stdout.write('The mod reads this after every turn: no restart needed. It acts only inside a Git repository, '
        + `once the context holds 200k tokens (idle window ${IDLE_MIN_MINUTES}-${IDLE_MAX_MINUTES} min).\n`);
    }
    return failed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`cah checkpoint-idle: ${error.message}\n`);
    return 1;
  }
}
