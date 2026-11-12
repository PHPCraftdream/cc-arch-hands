// nobg.js — wire bin/cah-nobg.js into a settings.json as one PreToolUse hook on
// the Bash tool: it denies a command that detaches a job (`&`, `nohup`, …).
// Hook editing (sentinel ownership, shared lock, compare-and-swap) is in
// sentinel-hooks.js.

import { HOOK_SENTINEL, createHookEditor, hookBinPath } from './sentinel-hooks.js';

export const NOBG_NAME = 'nobg';
export const NOBG_EVENTS = Object.freeze(['PreToolUse']);
const TIMEOUT_S = 10;

export function nobgHooks(binPath) {
  const path = hookBinPath(binPath);
  return {
    PreToolUse: {
      matcher: 'Bash',
      hooks: [{
        type: 'command', command: `node "${path}"`, timeout: TIMEOUT_S,
        'cah-sentinel': HOOK_SENTINEL, 'cah-name': NOBG_NAME,
      }],
    },
  };
}

const editor = createHookEditor({ name: NOBG_NAME, events: NOBG_EVENTS, wantedFor: nobgHooks });

export const nobgState = editor.state;
export const readNobgState = editor.read;
export const updateNobg = editor.update;
