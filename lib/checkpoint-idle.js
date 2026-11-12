// checkpoint-idle.js — the "checkpoint, compact and resume after N minutes of
// silence" switch of the checkpoint-watch mod. The mod reads
// { "cahCheckpointIdle": { "mode", "minutes" } } from the project's
// .claude/settings.local.json and, when that says nothing, from the user's
// settings.json (global: ~/.claude plus every ccgp profile). A local
// { "mode": "off" } switches a global setting off for one project.
// Writers share the settings lock and publish with compare-and-swap.

import { captureRegularFileSnapshot } from './fs-atomic-identity.js';
import { editSettings, parseSettings } from './checkpoint-watch.js';

export const IDLE_KEY = 'cahCheckpointIdle';
export const IDLE_MODES = Object.freeze(['checkpoint', 'commit']);
export const IDLE_DEFAULT_MINUTES = 30;
export const IDLE_MIN_MINUTES = 5;
export const IDLE_MAX_MINUTES = 50;

// What one settings object says: undefined (nothing), null (switched off) or
// { mode, minutes }. Mirrors idleOf() of the mod's engine.
export function idleIn(settings) {
  const value = settings?.[IDLE_KEY];
  if (!value || typeof value !== 'object') return undefined;
  if (value.mode === 'off') return null;
  if (!IDLE_MODES.includes(value.mode)) return undefined;
  const asked = value.minutes === null || value.minutes === '' ? NaN : Math.round(Number(value.minutes));
  const minutes = Number.isFinite(asked)
    ? Math.min(IDLE_MAX_MINUTES, Math.max(IDLE_MIN_MINUTES, asked)) : IDLE_DEFAULT_MINUTES;
  return { mode: value.mode, minutes };
}

export function readIdleState(settingsPath) {
  return idleIn(parseSettings(settingsPath, captureRegularFileSnapshot(settingsPath)));
}

export function describeIdle(state) {
  if (state === undefined) return 'not set';
  if (state === null) return 'off';
  return `on, mode ${state.mode}, ${state.minutes} min`;
}

// action 'enable' (mode, minutes), 'mute' (an explicit off that overrides a
// global setting) or 'disable' (drop the key). Resolves to 'enabled', 'updated',
// 'already-enabled', 'muted', 'already-muted', 'disabled' or 'not-set'.
export function updateIdle(settingsPath, action, { mode, minutes, lockOptions = {} } = {}) {
  if (action === 'enable') {
    if (!IDLE_MODES.includes(mode)) throw new Error(`unknown checkpoint-idle mode "${mode}"`);
    if (!Number.isInteger(minutes) || minutes < IDLE_MIN_MINUTES || minutes > IDLE_MAX_MINUTES) {
      throw new Error(`minutes must be a whole number from ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES}`);
    }
  }
  const outcome = editSettings(settingsPath, (settings) => {
    const current = settings[IDLE_KEY];
    if (action === 'enable') {
      if (current?.mode === mode && current?.minutes === minutes) return null;
      settings[IDLE_KEY] = { mode, minutes };
      return current === undefined ? 'enabled' : 'updated';
    }
    if (action === 'mute') {
      if (current?.mode === 'off') return null;
      settings[IDLE_KEY] = { mode: 'off' };
      return 'muted';
    }
    if (current === undefined) return null;
    delete settings[IDLE_KEY];
    return 'disabled';
  }, { create: action !== 'disable', lockOptions });
  if (outcome !== null) return outcome;
  return { enable: 'already-enabled', mute: 'already-muted', disable: 'not-set' }[action];
}
