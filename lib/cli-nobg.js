// `cah nobg on|off|status` — wire the cah-nobg PreToolUse hook into settings.json.

import { createHookCommand } from './cli-hook-command.js';
import { readNobgState, updateNobg } from './nobg.js';

export const cmdNobg = createHookCommand({
  name: 'nobg', noun: 'hook', update: updateNobg, readState: readNobgState,
});
