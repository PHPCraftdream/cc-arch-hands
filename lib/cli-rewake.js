// `cah rewake on|off|status` — wire the cah-rewake hooks into settings.json;
// `status` also shows the last events the bin logged.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHookCommand } from './cli-hook-command.js';
import { readRewakeState, updateRewake } from './rewake.js';

const LOG_TAIL = 5;

function logTail(binDir) {
  let lines;
  try {
    lines = readFileSync(join(binDir, 'cache', 'rewake.log'), 'utf8').trim().split('\n');
  } catch { return []; }
  return lines.filter(Boolean).slice(-LOG_TAIL);
}

function statusFooter(binDir) {
  const tail = logTail(binDir);
  return tail.length ? `last events:\n${tail.map((line) => `  ${line}`).join('\n')}\n`
    : 'last events: none yet\n';
}

export const cmdRewake = createHookCommand({
  name: 'rewake', noun: 'hooks', update: updateRewake, readState: readRewakeState, statusFooter,
});
