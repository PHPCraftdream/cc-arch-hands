// rewake.js — wire bin/cah-rewake.js into a settings.json as two hooks:
// StopFailure (async + asyncRewake: back off, then wake the session) and Stop
// (async: a completed turn resets the attempt counter).
//
// The hook editing (sentinel ownership, shared lock, atomic compare-and-swap)
// lives in sentinel-hooks.js.

import {
  HOOK_SENTINEL, HookBusyError, HookSettingsError, createHookEditor, hookBinPath,
} from './sentinel-hooks.js';

export { HOOK_SENTINEL };
export const RewakeSettingsError = HookSettingsError;
export const RewakeBusyError = HookBusyError;
export const REWAKE_NAME = 'rewake';
export const REWAKE_EVENTS = Object.freeze(['StopFailure', 'Stop']);
// Seconds. Longer than the 900 s back-off cap: Claude Code enforces it on asyncRewake hooks.
export const WAIT_TIMEOUT_S = 1000;
const RESET_TIMEOUT_S = 30;

export function rewakeHooks(binPath) {
  const path = hookBinPath(binPath);
  const hook = (mode, extra) => ({
    type: 'command', command: `node "${path}" ${mode}`, async: true, ...extra,
    'cah-sentinel': HOOK_SENTINEL, 'cah-name': REWAKE_NAME,
  });
  return {
    StopFailure: { matcher: '', hooks: [hook('wait', { asyncRewake: true, timeout: WAIT_TIMEOUT_S })] },
    Stop: { matcher: '', hooks: [hook('reset', { timeout: RESET_TIMEOUT_S })] },
  };
}

const editor = createHookEditor({ name: REWAKE_NAME, events: REWAKE_EVENTS, wantedFor: rewakeHooks });

export const rewakeState = editor.state;
export const readRewakeState = editor.read;
export const updateRewake = editor.update;
