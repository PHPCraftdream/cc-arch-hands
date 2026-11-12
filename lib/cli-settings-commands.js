// The subcommands that switch a feature on or off by writing settings files,
// keyed by their `cah <name>`. Kept apart so lib/cli.js stays under the
// source-size limit while the list grows.

import { cmdRewake } from './cli-rewake.js';
import { cmdCheckpointWatch } from './cli-checkpoint-watch.js';
import { cmdCheckpointIdle } from './cli-checkpoint-idle.js';

export const SettingsCommands = Object.freeze({
  rewake: cmdRewake,
  'checkpoint-watch': cmdCheckpointWatch,
  'checkpoint-idle': cmdCheckpointIdle,
});
