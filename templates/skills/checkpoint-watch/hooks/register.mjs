// cah checkpoint-watch mod: loaded by Claude Code from ~/.claude/skills/checkpoint-watch/.
// Acts only in a project whose .claude/settings.local.json enables it (`cah checkpoint-watch on`).
import { registerCheckpointWatch } from './engine.mjs';

export const register = (on) => {
  registerCheckpointWatch(on);
};
